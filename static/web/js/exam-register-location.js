(function () {
    "use strict";

    var form = document.querySelector('form[action*="temporary_user"]') || document.querySelector("form");
    var coordinateInput = document.getElementById("latitude");
    var mapElement = document.getElementById("location-map");
    var statusElement = document.getElementById("location-picker-status");
    var errorElement = document.getElementById("location-picker-error");
    var tokenElement = document.getElementById("mapbox-access-token");

    if (!form || !coordinateInput || !mapElement) {
        return;
    }

    var mapInstance = null;
    var marker = null;
    var mapReady = false;
    var setupError = false;
    var setupErrorMessage = "";
    var locationSelected = false;
    var defaultCenter = [76.2711, 10.8505];
    var defaultZoom = 7.2;

    function setStatus(message) {
        if (statusElement) {
            statusElement.textContent = message;
        }
    }

    function showError(message, isSetupError) {
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.hidden = false;
        }
        if (isSetupError) {
            setupError = true;
            setupErrorMessage = message;
            setStatus("The location picker is unavailable.");
        }
    }

    function clearError() {
        if (!setupError && errorElement) {
            errorElement.textContent = "";
            errorElement.hidden = true;
        }
    }

    function parseCoordinates(value) {
        var parts = String(value || "").split(",");
        if (parts.length !== 2) {
            return null;
        }

        var latitude = Number(parts[0].trim());
        var longitude = Number(parts[1].trim());
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
            latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            return null;
        }

        return { latitude: latitude, longitude: longitude };
    }

    function setCoordinates(latitude, longitude) {
        var coordinates = parseCoordinates(latitude + "," + longitude);
        if (!coordinates) {
            showError("We could not read that map location. Please select another point.", false);
            return;
        }

        coordinateInput.value = coordinates.latitude.toFixed(6) + "," + coordinates.longitude.toFixed(6);
        coordinateInput.setCustomValidity("");
        locationSelected = true;
        clearError();
        setStatus("Location selected. You can click another point or drag the marker to adjust it.");
    }

    function updateMarker(latitude, longitude) {
        if (!marker) {
            marker = new mapboxgl.Marker({ draggable: true })
                .setLngLat([longitude, latitude])
                .addTo(mapInstance);
            marker.on("dragend", function () {
                var markerLocation = marker.getLngLat();
                setCoordinates(markerLocation.lat, markerLocation.lng);
            });
        } else {
            marker.setLngLat([longitude, latitude]);
        }
    }

    function selectLocation(latitude, longitude) {
        updateMarker(latitude, longitude);
        setCoordinates(latitude, longitude);
    }

    function showSetupFailure(message) {
        showError(message, true);
        mapReady = false;
    }

    function mapErrorMessage(event) {
        var mapError = event && event.error;
        var message = mapError && (mapError.message || mapError.toString());
        return message ? String(message) : "Mapbox could not load the map.";
    }

    form.addEventListener("submit", function (event) {
        var coordinates = parseCoordinates(coordinateInput.value);

        if (setupError) {
            event.preventDefault();
            coordinateInput.setCustomValidity(setupErrorMessage);
            showError(setupErrorMessage, true);
            coordinateInput.reportValidity();
            return;
        }

        if (!mapReady || !locationSelected || !coordinates) {
            event.preventDefault();
            coordinateInput.setCustomValidity("Please select your location on the map before registering.");
            showError("Please select your location on the map before registering.", false);
            coordinateInput.reportValidity();
            return;
        }

        coordinateInput.setCustomValidity("");
    });

    var token = "";
    try {
        token = tokenElement ? JSON.parse(tokenElement.textContent || '""') : "";
    } catch (error) {
        showSetupFailure("The location picker setup is invalid. Please contact support.");
        return;
    }

    if (!token) {
        showSetupFailure("The location picker is unavailable because MAPBOX_ACCESS_TOKEN is not configured.");
        return;
    }

    if (typeof window.mapboxgl === "undefined" || typeof window.MapboxGeocoder === "undefined") {
        showSetupFailure("The location picker could not load Mapbox. Please check the Mapbox setup and try again.");
        return;
    }

    try {
        mapboxgl.accessToken = token;
        mapInstance = new mapboxgl.Map({
            container: mapElement,
            style: "mapbox://styles/mapbox/streets-v12",
            center: defaultCenter,
            zoom: defaultZoom,
            attributionControl: true
        });

        mapInstance.addControl(new mapboxgl.NavigationControl(), "top-right");

        var geocoder = new MapboxGeocoder({
            accessToken: token,
            mapboxgl: mapboxgl,
            marker: false,
            placeholder: "Search for your location"
        });
        mapInstance.addControl(geocoder, "top-left");

        mapInstance.on("load", function () {
            mapReady = true;
            setStatus("Click the map, search for a place, or drag the marker to choose your location.");
            mapInstance.resize();
        });

        mapInstance.on("click", function (event) {
            if (event && event.lngLat) {
                selectLocation(event.lngLat.lat, event.lngLat.lng);
            }
        });

        mapInstance.on("error", function (event) {
            if (!mapReady || (event && event.error && /401|403|unauthor|forbidden|token|style|failed|network|resource/i.test(mapErrorMessage(event)))) {
                showSetupFailure("Mapbox could not load the map. Please check the token and Mapbox availability.");
            }
        });

        geocoder.on("result", function (event) {
            var result = event && event.result;
            var coordinates = result && (result.center ||
                (result.geometry && result.geometry.coordinates));
            if (coordinates && coordinates.length >= 2) {
                mapInstance.flyTo({ center: coordinates, zoom: 14, essential: true });
                selectLocation(coordinates[1], coordinates[0]);
            }
        });

        geocoder.on("error", function () {
            showSetupFailure("Mapbox search is currently unavailable. Please try again later.");
        });

        window.setTimeout(function () {
            if (!mapReady && !setupError) {
                showSetupFailure("Mapbox took too long to load. Please check the Mapbox setup and try again.");
            }
        }, 10000);
    } catch (error) {
        showSetupFailure("The location picker could not start. Please check the Mapbox setup and try again.");
    }
})();