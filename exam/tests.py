
import base64
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings
from django.urls import get_script_prefix, resolve, reverse, set_script_prefix

from . import views
from .models import MainExamOption, MainExamProgress, MainExamQuestion, Payment
from .models.user_registration import (
    DocumentValidation,
    RegistrationDistrict,
    RegistrationPanchayat,
    RegistrationState,
    TemporaryUser,
)
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


class RegistrationPaymentAmountTests(TestCase):
    def setUp(self):
        self.amount_settings = override_settings(
            REGISTRATION_FEE=Decimal("5.00"),
            REGISTRATION_FEE_PAISE=500,
        )
        self.amount_settings.enable()
        self.addCleanup(self.amount_settings.disable)

    @patch("exam.views.razorpay.Client")
    def test_payment_order_uses_configured_registration_fee(self, client_class):
        client_class.return_value.order.create.return_value = {"id": "order_test_5"}

        response = self.client.post(reverse("exam:create_payment_order"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["amount"], 500)
        self.assertEqual(response.json()["registration_fee"], "5.00")
        self.assertEqual(
            client_class.return_value.order.create.call_args.kwargs["data"]["amount"],
            500,
        )

    def test_registration_page_displays_configured_fee(self):
        response = self.client.get(reverse("exam:entrepreneur_register"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Registration fee: ₹5.00")

    @patch("exam.views.tec_email_send")
    @patch("exam.views.razorpay.Client")
    def test_captured_payment_saves_registration_and_payment_at_same_amount(
        self, client_class, email_send
    ):
        state = RegistrationState.objects.create(name="Kerala")
        district = RegistrationDistrict.objects.create(
            state=state,
            district_name="Test District",
        )
        temp_user = TemporaryUser.objects.create(
            name="Test Centre",
            mobile="9000000001",
            email="test-centre@example.com",
            another_name="Test Parent",
            state=state.name,
            district=district.district_name,
            panchayat="Test Panchayat",
            ward_number="1",
            gender="male",
            aadhaar_number="123456789012",
            address="Test address",
        )
        session = self.client.session
        session["registration_user_id"] = temp_user.id
        session.save()

        razorpay_client = client_class.return_value
        razorpay_client.payment.fetch.return_value = {
            "status": "captured",
            "order_id": "order_test_5",
            "amount": 500,
            "currency": "INR",
            "email": temp_user.email,
        }

        response = self.client.post(
            reverse("exam:payment_success"),
            data={
                "payment_id": "pay_test_5",
                "razorpay_order_id": "order_test_5",
                "razorpay_signature": "signature_test_5",
            },
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        self.assertEqual(response.json()["receipt"]["amount"], "5.00")
        razorpay_client.utility.verify_payment_signature.assert_called_once()
        saved_payment = Payment.objects.get(provider_order_id="order_test_5")
        self.assertEqual(saved_payment.amount, 5.0)
        self.assertTrue(saved_payment.user_registration.is_paid)
        self.assertTrue(TemporaryUser.objects.get(pk=temp_user.pk).payment)
        email_send.assert_called_once()

    @patch("exam.views.razorpay.Client")
    def test_payment_amount_mismatch_does_not_save_records(self, client_class):
        temp_user = TemporaryUser.objects.create(
            name="Mismatch Centre",
            mobile="9000000002",
            email="mismatch@example.com",
            state="Kerala",
            district="Test District",
            panchayat="Test Panchayat",
            ward_number="1",
            gender="male",
            aadhaar_number="123456789013",
            address="Test address",
        )
        session = self.client.session
        session["registration_user_id"] = temp_user.id
        session.save()

        razorpay_client = client_class.return_value
        razorpay_client.payment.fetch.return_value = {
            "status": "captured",
            "order_id": "order_wrong_amount",
            "amount": 146900,
            "currency": "INR",
            "email": temp_user.email,
        }

        response = self.client.post(
            reverse("exam:payment_success"),
            data={
                "payment_id": "pay_wrong_amount",
                "razorpay_order_id": "order_wrong_amount",
                "razorpay_signature": "signature_wrong_amount",
            },
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "Payment amount mismatch")
        self.assertFalse(Payment.objects.exists())
        self.assertFalse(TemporaryUser.objects.get(pk=temp_user.pk).payment)


class RegistrationSubmissionFlowTests(TestCase):
    TEST_IMAGE = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
        "YAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    )

    def setUp(self):
        self.amount_settings = override_settings(
            REGISTRATION_FEE=Decimal("5.00"),
            REGISTRATION_FEE_PAISE=500,
        )
        self.amount_settings.enable()
        self.addCleanup(self.amount_settings.disable)

        self.media_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.media_directory.cleanup)
        self.media_settings = override_settings(MEDIA_ROOT=self.media_directory.name)
        self.media_settings.enable()
        self.addCleanup(self.media_settings.disable)

        self.state = RegistrationState.objects.create(name="Kerala")
        self.district = RegistrationDistrict.objects.create(
            state=self.state,
            district_name="Test District",
        )
        self.panchayat = RegistrationPanchayat.objects.create(
            state=self.state,
            district=self.district,
            local_body="Panchayath",
            name="Test Panchayat",
        )

    def registration_payload(self, latitude="10.000000,76.000000"):
        return {
            "name": "Final Centre",
            "another_name": "Test Parent",
            "gender": "male",
            "date_of_birth": "1990-01-01",
            "aadhaar_number": "123456789012",
            "email": "final-centre@example.com",
            "mobile": "9000000009",
            "state": str(self.state.pk),
            "district": str(self.district.pk),
            "local_body": "Panchayath",
            "panchayat": str(self.panchayat.pk),
            "ward_number": "1",
            "address": "Test address",
            "latitude": latitude,
            "photo": SimpleUploadedFile(
                "photo.png", self.TEST_IMAGE, content_type="image/png"
            ),
            "cheque_passbook": SimpleUploadedFile(
                "cheque.png", self.TEST_IMAGE, content_type="image/png"
            ),
        }

    @patch("exam.views.razorpay.Client")
    def test_valid_final_submission_reaches_payment_page_at_test_amount(self, client_class):
        client_class.return_value.order.create.return_value = {
            "id": "order_final_5"
        }

        response = self.client.post(
            reverse("exam:entrepreneur_register"), self.registration_payload()
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'initialOrderId = "order_final_5"')
        self.assertContains(response, "5.00")
        self.assertEqual(TemporaryUser.objects.count(), 1)
        saved_user = TemporaryUser.objects.get()
        self.assertTrue(saved_user.photo.name)
        self.assertTrue(saved_user.cheque_passbook.name)
        self.assertEqual(
            client_class.return_value.order.create.call_args.kwargs["data"]["amount"],
            500,
        )
        order_response = self.client.post(reverse("exam:create_payment_order"))
        self.assertEqual(order_response.status_code, 200)
        self.assertEqual(order_response.json()["razorpay_order_id"], "order_final_5")
        client_class.return_value.order.create.assert_called_once()

    @patch("exam.views.razorpay.Client")
    def test_invalid_final_submission_stays_on_location_step(self, client_class):
        payload = self.registration_payload(latitude="")

        response = self.client.post(
            reverse("exam:entrepreneur_register"), payload
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-initial-step="3"')
        self.assertContains(response, "Please select a valid location on the map.")
        self.assertContains(response, "Final Centre")
        self.assertEqual(TemporaryUser.objects.count(), 0)
        client_class.return_value.order.create.assert_not_called()

    @patch("exam.views.razorpay.Client")
    def test_repeated_final_submission_reuses_temp_user_and_order(self, client_class):
        client_class.return_value.order.create.return_value = {
            "id": "order_final_5"
        }
        url = reverse("exam:entrepreneur_register")

        first_response = self.client.post(url, self.registration_payload())
        second_response = self.client.post(url, self.registration_payload())

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(TemporaryUser.objects.count(), 1)
        client_class.return_value.order.create.assert_called_once()

    def test_registration_urls_render_with_test_script_prefix(self):
        previous_prefix = get_script_prefix()
        set_script_prefix("/test/")
        self.addCleanup(set_script_prefix, previous_prefix)

        registration_url = reverse("exam:entrepreneur_register")
        # The reverse proxy strips /test/ before Django receives the request.
        response = self.client.get("/exam/register/")

        self.assertEqual(registration_url, "/test/exam/register/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, f'action="{registration_url}"')

    def test_registration_entry_points_do_not_return_server_error(self):
        for route_name in ("exam:entrepreneur_register", "exam:temporary_user"):
            with self.subTest(route_name=route_name):
                self.assertEqual(self.client.get(reverse(route_name)).status_code, 200)
