from django.conf import settings


def integration_keys(request):
    return {"GOOGLE_MAPS_API_KEY": settings.GOOGLE_MAPS_API_KEY}
