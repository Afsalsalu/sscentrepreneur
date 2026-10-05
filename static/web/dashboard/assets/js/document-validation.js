(() => {
    const DOCUMENT_UPLOAD_RESPONSE_ERROR = "Document upload could not be completed. Please retry.";
    const uploadUrl = document.body?.dataset.uploadUrl || "";
    const userVideo = document.getElementById("user-video");
    const aadhaarVideo = document.getElementById("aadhaar-video");
    const userPreview = document.getElementById("user-preview");
    const aadhaarPreview = document.getElementById("aadhaar-preview");
    const captureUserButton = document.getElementById("capture-user-btn");
    const captureAadhaarButton = document.getElementById("capture-aadhaar-btn");
    const nextAadhaarButton = document.getElementById("next-aadhaar-btn");
    const verificationButton = document.getElementById("get-verification-btn");
    const uploadButton = document.getElementById("upload-submit-btn");
    const cameraError = document.getElementById("camera-error");
    const cameraErrorMessage = document.getElementById("camera-error-message");
    const retryCameraButton = document.getElementById("retry-camera-btn");
    const uploadError = document.getElementById("document-upload-error");

    let cameraStream = null;
    let userImage = "";
    let aadhaarImage = "";

    function responseHasJsonContentType(response) {
        const contentType = response.headers?.get("content-type") || "";
        const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
        return mediaType === "application/json" || mediaType.endsWith("+json");
    }

    async function parseJsonResponse(response, fallbackMessage) {
        if (!response.ok || !responseHasJsonContentType(response)) {
            throw new Error(fallbackMessage);
        }

        try {
            return await response.json();
        } catch (error) {
            console.error("Document validation JSON response parsing failed.");
            throw new Error(fallbackMessage);
        }
    }

    function cameraErrorText(error) {
        switch (error?.name) {
            case "NotAllowedError":
            case "SecurityError":
                return "Camera permission was denied. Allow camera access in the browser and retry.";
            case "NotFoundError":
                return "No camera was found. Connect a camera and retry.";
            case "NotReadableError":
                return "The camera is busy or unavailable. Close other camera apps and retry.";
            default:
                return error?.message || "The camera could not be started. Please retry.";
        }
    }

    function showCameraError(error) {
        console.error("Document validation camera error:", error);
        if (cameraErrorMessage) cameraErrorMessage.textContent = cameraErrorText(error);
        if (cameraError) cameraError.hidden = false;
        if (retryCameraButton) retryCameraButton.hidden = false;
        if (captureUserButton) captureUserButton.disabled = true;
        if (captureAadhaarButton) captureAadhaarButton.disabled = true;
    }

    function clearCameraError() {
        if (cameraError) cameraError.hidden = true;
        if (retryCameraButton) retryCameraButton.hidden = true;
    }

    function showUploadError(message = DOCUMENT_UPLOAD_RESPONSE_ERROR) {
        if (!uploadError) return;
        uploadError.textContent = message;
        uploadError.hidden = false;
    }

    function clearUploadError() {
        if (uploadError) uploadError.hidden = true;
    }

    function stopCamera() {
        if (!cameraStream) return;
        cameraStream.getTracks().forEach((track) => track.stop());
        cameraStream = null;
        [userVideo, aadhaarVideo].filter(Boolean).forEach((video) => {
            video.srcObject = null;
        });
    }

    function videoIsReady(video) {
        return Boolean(video && video.readyState >= 2 && video.videoWidth && video.videoHeight);
    }

    function waitForVideoReady(video) {
        if (videoIsReady(video)) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                video.removeEventListener("loadeddata", onReady);
                video.removeEventListener("canplay", onReady);
                reject(new Error("The camera stream did not produce a video frame."));
            }, 5000);

            function onReady() {
                if (!videoIsReady(video)) return;
                window.clearTimeout(timeoutId);
                video.removeEventListener("loadeddata", onReady);
                video.removeEventListener("canplay", onReady);
                resolve();
            }

            video.addEventListener("loadeddata", onReady);
            video.addEventListener("canplay", onReady);
        });
    }

    async function setupCamera() {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("This browser does not support camera access.");
        }

        clearCameraError();
        stopCamera();
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        cameraStream.getTracks().forEach((track) => {
            track.addEventListener("ended", () => showCameraError(new Error("The camera stream stopped.")), { once: true });
        });

        [userVideo, aadhaarVideo].filter(Boolean).forEach((video) => {
            video.srcObject = cameraStream;
            video.play().catch((error) => console.error("Unable to start camera preview:", error));
        });

        // The user capture button only depends on the visible user preview.
        // Do not wait for the Aadhaar preview, which is hidden until later.
        await waitForVideoReady(userVideo);
        captureUserButton.disabled = false;
    }

    async function enableAadhaarCapture() {
        await waitForVideoReady(aadhaarVideo);
        captureAadhaarButton.disabled = false;
    }

    function captureImage(video, preview) {
        if (!videoIsReady(video)) {
            showCameraError(new Error("The camera preview is not ready. Please retry camera access."));
            return "";
        }

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = canvas.toDataURL("image/jpeg");
        preview.src = image;
        preview.style.display = "block";
        return image;
    }

    function showAadhaarSection() {
        document.getElementById("user-section").classList.remove("active");
        document.getElementById("aadhaar-section").classList.add("active");
        enableAadhaarCapture().catch(showCameraError);
    }

    function showVerificationSection() {
        document.getElementById("aadhaar-section").classList.remove("active");
        document.getElementById("uploaded-section").classList.add("active");

        document.getElementById("uploaded-user-preview").src = userImage;
        document.getElementById("uploaded-user-preview").style.display = "block";
        document.getElementById("uploaded-aadhaar-preview").src = aadhaarImage;
        document.getElementById("uploaded-aadhaar-preview").style.display = "block";
        uploadButton.hidden = false;
    }

    async function uploadImages() {
        if (!uploadUrl || !userImage || !aadhaarImage) {
            showUploadError("Please capture both images before uploading.");
            return;
        }

        uploadButton.disabled = true;
        clearUploadError();
        document.getElementById("user-loading").style.display = "block";
        document.getElementById("aadhaar-loading").style.display = "block";

        const csrfToken = document.querySelector("#document-validation-csrf-form input[name='csrfmiddlewaretoken']")?.value;
        try {
            const response = await fetch(uploadUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
                    ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
                },
                credentials: "same-origin",
                body: new URLSearchParams({
                    aadhaar_image: aadhaarImage,
                    user_image: userImage,
                }),
            });
            const data = await parseJsonResponse(response, DOCUMENT_UPLOAD_RESPONSE_ERROR);

            document.getElementById("user-success").style.display = "block";
            document.getElementById("aadhaar-success").style.display = "block";
            if (data.redirect_url) window.location.assign(data.redirect_url);
        } catch (error) {
            console.error("Document upload failed", { errorName: error?.name || "Error" });
            showUploadError(DOCUMENT_UPLOAD_RESPONSE_ERROR);
            uploadButton.disabled = false;
        } finally {
            document.getElementById("user-loading").style.display = "none";
            document.getElementById("aadhaar-loading").style.display = "none";
        }
    }

    function initializePage() {
        try {
            if (
                !captureUserButton || !captureAadhaarButton || !uploadButton ||
                !userVideo || !aadhaarVideo || !userPreview || !aadhaarPreview ||
                !nextAadhaarButton || !verificationButton || !retryCameraButton
            ) {
                throw new Error("Document validation controls are missing from the page.");
            }

            captureUserButton.addEventListener("click", () => {
                userImage = captureImage(userVideo, userPreview);
                nextAadhaarButton.disabled = !userImage;
            });
            nextAadhaarButton.addEventListener("click", showAadhaarSection);
            captureAadhaarButton.addEventListener("click", () => {
                aadhaarImage = captureImage(aadhaarVideo, aadhaarPreview);
                verificationButton.disabled = !aadhaarImage;
            });
            verificationButton.addEventListener("click", showVerificationSection);
            uploadButton.addEventListener("click", uploadImages);
            retryCameraButton.addEventListener("click", () => {
                retryCameraButton.disabled = true;
                setupCamera().catch(showCameraError).finally(() => {
                    retryCameraButton.disabled = false;
                });
            });

            setupCamera().catch(showCameraError);
        } catch (error) {
            showCameraError(error);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializePage, { once: true });
    } else {
        initializePage();
    }
})();
