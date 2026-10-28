"""Django settings for the SS Centrepreneur project.

Secrets and deployment-specific values are supplied through the environment.
"""

import os
from pathlib import Path

from decouple import config
from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env", override=False)


def _first_env(*names, default=""):
    """Return the first non-empty environment value from ``names``."""
    for name in names:
        value = config(name, default="")
        if value != "":
            return value
    return default


def _env_list(name, default=()):
    value = config(name, default="")
    values = [item.strip() for item in value.split(",") if item.strip()]
    return values or list(default)


def _env_bool(name, default=False):
    value = config(name, default="").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on", "y"}


def _unique(values):
    return list(dict.fromkeys(values))


DJANGO_ENV = config("DJANGO_ENV", default="development").strip().lower()
IS_PRODUCTION = DJANGO_ENV == "production"

SECRET_KEY = _first_env("DJANGO_SECRET_KEY", "SECRET_KEY")
if not SECRET_KEY:
    raise ImproperlyConfigured("Set DJANGO_SECRET_KEY or SECRET_KEY in the environment")

DEBUG = _env_bool("DEBUG", default=not IS_PRODUCTION)

DEFAULT_ALLOWED_HOSTS = [
    "sscentrepreneur.com",
    "www.sscentrepreneur.com",
    "localhost",
    "127.0.0.1",
]
ALLOWED_HOSTS = _unique(DEFAULT_ALLOWED_HOSTS + _env_list("ALLOWED_HOSTS"))

_script_name = _first_env("FORCE_SCRIPT_NAME").strip()
if _script_name:
    FORCE_SCRIPT_NAME = "/" + _script_name.strip("/") + "/"
    _url_prefix = FORCE_SCRIPT_NAME.rstrip("/")
else:
    FORCE_SCRIPT_NAME = None
    _url_prefix = ""

STATIC_URL = f"{_url_prefix}/static/" if _url_prefix else "/static/"
MEDIA_URL = f"{_url_prefix}/media/" if _url_prefix else "/media/"

_default_csrf_origins = ["http://localhost", "http://127.0.0.1"]
if IS_PRODUCTION:
    _default_csrf_origins.extend(
        ["https://sscentrepreneur.com", "https://www.sscentrepreneur.com"]
    )
CSRF_TRUSTED_ORIGINS = _unique(
    _default_csrf_origins + _env_list("CSRF_TRUSTED_ORIGINS")
)


X_FRAME_OPTIONS = "SAMEORIGIN"

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "web",
    "registration",
    "crispy_forms",
    "crispy_bootstrap5",
    "captcha",
    "exam",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]

ROOT_URLCONF = "ssc.urls"
WSGI_APPLICATION = "ssc.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "ssc.context_processors.integration_keys",
            ],
        },
    },
]

AUTHENTICATION_BACKENDS = ["django.contrib.auth.backends.ModelBackend"]


def _database_settings():
    return {
        "ENGINE": config("DB_ENGINE", default="django.db.backends.mysql"),
        "NAME": config("DB_NAME", default=""),
        "USER": config("DB_USER", default=""),
        "PASSWORD": config("DB_PASSWORD", default=""),
        "HOST": config("DB_HOST", default=""),
        "PORT": config("DB_PORT", default="3306"),
        "OPTIONS": {"charset": "utf8mb4"},
    }


DATABASES = {
    "default": _database_settings(),
    "ssc": _database_settings(),
}

AUTH_PASSWORD_VALIDATORS = os.getenv("AUTH_PASSWORD_VALIDATORS", "")

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Kolkata"
USE_I18N = True
USE_TZ = True

STATICFILES_DIRS = [BASE_DIR / "static"]
STATIC_ROOT = BASE_DIR / "assets"
STATICFILES_STORAGE = "whitenoise.storage.CompressedStaticFilesStorage"
MEDIA_ROOT = BASE_DIR / "media"

CRISPY_ALLOWED_TEMPLATE_PACKS = "bootstrap5"
CRISPY_TEMPLATE_PACK = "bootstrap5"

ACCOUNT_ACTIVATION_DAYS = 7
REGISTRATION_AUTO_LOGIN = True
SEND_ACTIVATION_EMAIL = True
REGISTRATION_EMAIL_SUBJECT_PREFIX = config(
    "REGISTRATION_EMAIL_SUBJECT_PREFIX", default=""
)
REGISTRATION_OPEN = True
LOGIN_URL = "/custom_login"
LOGOUT_URL = "/accounts/logout/"
LOGIN_REDIRECT_URL = "/dashboard/"
LOGOUT_REDIRECT_URL = "/"


# Sensitive configuration is supplied through the environment.
# Sensitive configuration is supplied through the environment.
RAZORPAY_KEY_ID = config("RAZORPAY_KEY_ID", default="")
RAZORPAY_KEY_SECRET = config("RAZORPAY_KEY_SECRET", default="")
RAZORPAY_SECRET_KEY = os.getenv("RAZORPAY_SECRET_KEY", "")
RAZORPAY_API_KEY = os.getenv("RAZORPAY_API_KEY", "")
PSPDFKIT_API_KEY = config("PSPDFKIT_API_KEY", default="")
RECAPTCHA_SITE_KEY = config("RECAPTCHA_SITE_KEY", default="")
RECAPTCHA_SECRET_KEY = config("RECAPTCHA_SECRET_KEY", default="")
MAPBOX_ACCESS_TOKEN = config("MAPBOX_ACCESS_TOKEN", default="")
GOOGLE_MAPS_API_KEY = config("GOOGLE_MAPS_API_KEY", default="")

SENDINBLUE_API_KEY = config("SENDINBLUE_API_KEY", default="")
BREVO_API_KEY = os.getenv("SENDINBLUE_API_KEY", "")
ANYMAIL = {"BREVO": {"API_KEY": SENDINBLUE_API_KEY}}

EMAIL_BACKEND = config(
    "EMAIL_BACKEND", default="django.core.mail.backends.smtp.EmailBackend"
)
EMAIL_HOST = _first_env("SMTP_HOST", "EMAIL_HOST", default="smtp-relay.brevo.com")
EMAIL_PORT = config("SMTP_PORT", default=config("EMAIL_PORT", default=587), cast=int)
EMAIL_USE_TLS = _env_bool("EMAIL_USE_TLS", default=True)
EMAIL_HOST_USER = _first_env("SMTP_USERNAME", "EMAIL_HOST_USER")
EMAIL_HOST_PASSWORD = os.getenv("SMTP_PASSWORD", "")
DEFAULT_FROM_EMAIL = _first_env("DEFAULT_FROM_EMAIL", default=EMAIL_HOST_USER)


SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
CSRF_FAILURE_VIEW = "web.views.custom_csrf_failure"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {
        "handlers": ["console"],
        "level": config("LOG_LEVEL", default="INFO" if IS_PRODUCTION else "DEBUG"),
    },
}

FILE_CHARSET = "utf-8"
DEFAULT_CHARSET = "utf-8"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "web.User"
