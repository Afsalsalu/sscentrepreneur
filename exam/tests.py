
import base64
import tempfile
from pathlib import Path

from django.contrib.auth import get_user_model
from django.conf import settings
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings
from django.urls import get_script_prefix, resolve, reverse, set_script_prefix

from . import views
from .models import MainExamOption, MainExamProgress, MainExamQuestion
from .models.user_registration import DocumentValidation, TemporaryUser
from web import views as web_views

User = get_user_model()


class MainExamRoutingTests(SimpleTestCase):
    """Protect the active Main Exam route contract without touching the database."""

    def test_main_exam_route_uses_active_view(self):
        self.assertEqual(reverse("exam:main_exam"), "/exam/main-exam/")
        self.assertIs(resolve("/exam/main-exam/").func, views.main_exam)

    def test_identity_verification_route_remains_available(self):
        self.assertEqual(reverse("exam:capture_image"), "/exam/capture_image/")
        self.assertIs(resolve("/exam/capture_image/").func, views.capture_image)

    def test_exam_urls_honor_a_test_script_prefix(self):
        previous_prefix = get_script_prefix()
        set_script_prefix("/test/")
        self.addCleanup(set_script_prefix, previous_prefix)

        self.assertEqual(reverse("exam:upload_images"), "/test/exam/upload/")
        self.assertEqual(reverse("exam:main_exam"), "/test/exam/main-exam/")
        self.assertEqual(reverse("exam:capture_image"), "/test/exam/capture_image/")
        self.assertEqual(reverse("exam:dashboard"), "/test/exam/dashboard/")

    def test_main_exam_renders_runtime_urls_in_data_attributes(self):
        template_path = Path(settings.BASE_DIR) / "templates/web/exam/main_exam.html"
        template = template_path.read_text(encoding="utf-8")

        self.assertIn('data-submit-url="{% url \'exam:main_exam\' %}"', template)
        self.assertIn('data-dashboard-url="{% url \'exam:dashboard\' %}"', template)
        self.assertIn('data-identity-verification-url="{% url \'exam:capture_image\' %}"', template)
        self.assertNotIn("window.MAIN_EXAM_CONFIG", template)


class MainExamJsonSafetyTests(SimpleTestCase):
    def setUp(self):
        self.script = (
            Path(settings.BASE_DIR) / "static/web/dashboard/assets/js/main-exam.js"
        ).read_text(encoding="utf-8")

    def test_main_exam_uses_one_guarded_json_parser_and_no_alert(self):
        self.assertEqual(self.script.count("response.json()"), 1)
        self.assertIn("async function requestJson", self.script)
        self.assertIn('credentials: "same-origin"', self.script)
        self.assertNotIn("window.alert(", self.script)
        self.assertNotIn("/capture_image/", self.script)
        self.assertNotIn("/main-exam/", self.script)

    def test_json_accepting_csrf_failure_returns_json_403(self):
        request = RequestFactory().post(
            "/test/exam/capture_image/",
            HTTP_ACCEPT="application/json",
        )
        response = web_views.custom_csrf_failure(request)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.headers["Content-Type"], "application/json")


class DocumentValidationJavaScriptTests(SimpleTestCase):
    def test_user_capture_binds_and_does_not_wait_for_hidden_aadhaar_video(self):
        script_path = Path(settings.BASE_DIR) / "static/web/dashboard/assets/js/document-validation.js"
        script = script_path.read_text(encoding="utf-8")

        self.assertIn('captureUserButton.addEventListener("click"', script)
        self.assertIn("await waitForVideoReady(userVideo)", script)
        self.assertNotIn("Promise.all(cameraVideos.map", script)

    def test_upload_json_errors_are_guarded_without_browser_alerts(self):
        script_path = Path(settings.BASE_DIR) / "static/web/dashboard/assets/js/document-validation.js"
        script = script_path.read_text(encoding="utf-8")

        self.assertEqual(script.count("response.json()"), 1)
        self.assertIn("async function parseJsonResponse", script)
        self.assertNotIn("window.alert(", script)


class ExamBrowserFlowTests(TestCase):
    """Exercise the active browser endpoints without touching the real database."""

    def setUp(self):
        self.media_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.media_directory.cleanup)
        self.media_settings = override_settings(MEDIA_ROOT=self.media_directory.name)
        self.media_settings.enable()
        self.addCleanup(self.media_settings.disable)

        self.user = User.objects.create_user(username="exam-flow", password="secret")
        self.temporary_user = TemporaryUser.objects.create(
            user=self.user,
            name="Exam Candidate",
            mobile="9000000001",
            email="exam-flow@example.com",
            state="Kerala",
            district="1",
            panchayat="Test Panchayat",
            ward_number="1",
            gender="male",
            aadhaar_number="123456789012",
            address="Test address",
        )
        self.client = Client(enforce_csrf_checks=True)
        self.client.force_login(self.user)

    def test_document_validation_renders_generated_upload_url_and_accepts_csrf_post(self):
        page = self.client.get(reverse("exam:document_validation"))
        self.assertEqual(page.status_code, 200)
        self.assertIn(
            f'data-upload-url="{reverse("exam:upload_images")}"',
            page.content.decode(),
        )

        image = base64.b64encode(b"test-image").decode()
        payload = {
            "aadhaar_image": f"data:image/jpeg;base64,{image}",
            "user_image": f"data:image/jpeg;base64,{image}",
        }
        self.assertNotEqual(
            self.client.post(reverse("exam:upload_images"), payload).status_code,
            201,
        )

        response = self.client.post(
            reverse("exam:upload_images"),
            {
                **payload,
                "csrfmiddlewaretoken": page.cookies["csrftoken"].value,
            },
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["redirect_url"], reverse("exam:main_exam"))
        self.assertTrue(DocumentValidation.objects.filter(user=self.temporary_user).exists())

    def test_main_exam_form_posts_to_active_scoring_view(self):
        question = MainExamQuestion.objects.create(question_text="Test question")
        wrong_option = MainExamOption.objects.create(
            question=question,
            option="Wrong",
            is_correct=False,
        )

        page = self.client.get(reverse("exam:main_exam"))
        self.assertEqual(page.status_code, 200)
        self.assertIn(
            f'action="{reverse("exam:main_exam")}"',
            page.content.decode(),
        )
        response = self.client.post(
            reverse("exam:main_exam"),
            {
                f"question_{question.id}": str(wrong_option.id),
                "csrfmiddlewaretoken": page.cookies["csrftoken"].value,
            },
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], reverse("exam:dashboard"))
        progress = MainExamProgress.objects.get(user=self.user)
        self.assertEqual(progress.correct_answers, 0)
        self.assertEqual(progress.total_questions, 1)
