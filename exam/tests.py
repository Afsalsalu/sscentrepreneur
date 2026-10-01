
# Create your tests here.
from django.test import SimpleTestCase
from django.urls import resolve, reverse

from . import views


class MainExamRoutingTests(SimpleTestCase):
    """Protect the active Main Exam route contract without touching the database."""

    def test_main_exam_route_uses_active_view(self):
        self.assertEqual(reverse("exam:main_exam"), "/exam/main-exam/")
        self.assertIs(resolve("/exam/main-exam/").func, views.main_exam)

    def test_identity_verification_route_remains_available(self):
        self.assertEqual(reverse("exam:capture_image"), "/exam/capture_image/")
        self.assertIs(resolve("/exam/capture_image/").func, views.capture_image)
