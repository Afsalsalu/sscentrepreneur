# exam/admin/option_admin.py
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.db import transaction
from django.forms.models import BaseInlineFormSet
from django.utils.html import format_html

from exam.models.option import MainExamOption, Option
from exam.models.question import Question


class OptionInline(admin.TabularInline):
    model = Option
    fields = ("option", "is_correct")
    extra = 1


class QuestionInline(admin.TabularInline):
    model = Question
    fields = ("question",)
    extra = 10


class MainExamOptionInlineFormSet(BaseInlineFormSet):
    def clean(self):
        super().clean()

        if any(self.errors):
            return

        correct_options = [
            form
            for form in self.forms
            if form.cleaned_data.get("is_correct")
            and not form.cleaned_data.get("DELETE", False)
        ]
        if len(correct_options) > 1:
            raise ValidationError(
                "Only one option can be marked as correct for a question."
            )


class MainExamOptionInline(admin.TabularInline):
    model = MainExamOption
    formset = MainExamOptionInlineFormSet
    fields = ("option", "is_correct")
    extra = 1
    readonly_fields = ("is_correct_display",)

    def save_formset(self, request, form, formset, change):
        # Save the parent instance first if necessary
        if formset.model == MainExamOption:
            if not change and form.instance.pk is None:
                form.instance.save()
        with transaction.atomic():
            super().save_formset(request, form, formset, change)

    def is_correct_display(self, obj):
        return format_html(
            '<span style="color: {};">{}</span>',
            "green" if obj.is_correct else "red",
            "Correct" if obj.is_correct else "Incorrect",
        )

    is_correct_display.short_description = "Correct Option"
