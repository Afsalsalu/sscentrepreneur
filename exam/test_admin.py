from types import SimpleNamespace

from django.contrib.admin.sites import AdminSite
from django.test import RequestFactory, TestCase

from .admin.option_admin import MainExamOptionInline
from .models import MainExamOption, MainExamQuestion


class MainExamOptionInlineValidationTests(TestCase):
    def setUp(self):
        self.inline = MainExamOptionInline(MainExamQuestion, AdminSite())
        self.request = RequestFactory().get("/")
        self.request.user = SimpleNamespace(has_perm=lambda *args, **kwargs: True)

    def build_formset(self, question, options, initial_forms=0):
        formset_class = self.inline.get_formset(
            request=self.request, obj=question
        )
        unbound_formset = formset_class(instance=question)
        prefix = unbound_formset.prefix
        data = {
            f"{prefix}-TOTAL_FORMS": str(len(options)),
            f"{prefix}-INITIAL_FORMS": str(initial_forms),
            f"{prefix}-MIN_NUM_FORMS": "0",
            f"{prefix}-MAX_NUM_FORMS": "1000",
        }
        for index, option in enumerate(options):
            data[f"{prefix}-{index}-option"] = option["option"]
            if option.get("is_correct"):
                data[f"{prefix}-{index}-is_correct"] = "on"
            if option.get("id"):
                data[f"{prefix}-{index}-id"] = str(option["id"])
        return formset_class(data=data, instance=question)

    def test_new_unsaved_question_accepts_one_correct_option(self):
        question = MainExamQuestion(question_text="New question")
        formset = self.build_formset(
            question,
            [{"option": "Correct", "is_correct": True}],
        )

        self.assertTrue(formset.is_valid(), formset.errors)

        question.save()
        saved_options = formset.save()

        self.assertEqual(len(saved_options), 1)
        self.assertTrue(saved_options[0].is_correct)

    def test_new_unsaved_question_rejects_multiple_correct_options(self):
        question = MainExamQuestion(question_text="New question")
        formset = self.build_formset(
            question,
            [
                {"option": "First", "is_correct": True},
                {"option": "Second", "is_correct": True},
            ],
        )

        self.assertFalse(formset.is_valid())
        self.assertIn(
            "Only one option can be marked as correct for a question.",
            formset.non_form_errors(),
        )

    def test_existing_question_rejects_second_correct_option(self):
        question = MainExamQuestion.objects.create(question_text="Existing question")
        existing_option = MainExamOption.objects.create(
            question=question,
            option="Existing correct",
            is_correct=True,
        )
        formset = self.build_formset(
            question,
            [
                {
                    "id": existing_option.pk,
                    "option": existing_option.option,
                    "is_correct": True,
                },
                {"option": "Second correct", "is_correct": True},
            ],
            initial_forms=1,
        )

        self.assertFalse(formset.is_valid())
        self.assertEqual(formset.errors[0], {})
        self.assertIn(
            "Only one option can be marked as correct for a question.",
            formset.errors[1]["__all__"],
        )
