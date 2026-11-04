const pageData = document.body?.dataset || {};
const config = Object.freeze({
    submitUrl: pageData.submitUrl || "",
    dashboardUrl: pageData.dashboardUrl || "",
    identityVerificationUrl: pageData.identityVerificationUrl || "",
    mediapipePackageUrl: pageData.mediapipePackageUrl || "",
    mediapipeWasmUrl: pageData.mediapipeWasmUrl || "",
    faceLandmarkerModelUrl: pageData.faceLandmarkerModelUrl || "",
});

const TEMPORARY_CONNECTION_MESSAGE =
    "A temporary connection issue occurred. Please continue your exam or try again.";
const IDENTITY_VERIFICATION_RESPONSE_ERROR = TEMPORARY_CONNECTION_MESSAGE;
const WARNING_COOLDOWN_MS = 8000;
const MAX_WARNINGS = 3;
const INFERENCE_INTERVAL_MS = 100;
const MONITORING_READINESS_TIMEOUT_MS = 10000;
const MAX_CONSECUTIVE_INFERENCE_FAILURES = 3;
const MONITORING_BLOCKING_MESSAGE =
    "Camera monitoring could not start. Select a working camera and retry before starting the exam.";
const WARNING_RULES = {
    noFace: {
        message: "Face not visible. Please sit in front of the camera.",
        durationMs: 3000,
    },
    multipleFaces: {
        message: "More than one person detected. Only the candidate may remain in view.",
        durationMs: 1000,
    },
    headTurned: {
        message: "Please look at the screen and keep your face facing the camera.",
        durationMs: 2000,
    },
    eyesClosed: {
        message: "Please keep your eyes open and remain attentive.",
        durationMs: 1500,
    },
    cameraStopped: {
        message: "Camera monitoring stopped. Please reconnect or allow camera access.",
        durationMs: 0,
    },
    identityMismatch: {
        message: "Identity verification did not match the registered candidate.",
        durationMs: 0,
    },
};

const conditionState = Object.fromEntries(
    Object.keys(WARNING_RULES)
        .filter((type) => !["cameraStopped", "identityMismatch"].includes(type))
        .map((type) => [type, { since: null, warned: false }])
);

let faceLandmarker = null;
let mediaStream = null;
let monitoringLoopId = null;
let monitoringReady = false;
let monitoringActive = false;
let examStarted = false;
let cleanupStarted = false;
let submissionStarted = false;
let lastInferenceAt = 0;
let lastVideoTimestamp = 0;
let capabilitiesChecked = false;
let activeWarning = null;
let warningCount = 0;
let warningTerminationStarted = false;
let cameraStoppedIncidentActive = false;
let selectedDeviceId = null;
let cameraDevices = [];
let cameraDeviceTokens = new Map();
let cameraSelectionRequired = false;
let cameraPermissionGranted = false;
let monitoringBlocked = true;
let monitoringAttemptId = 0;
let consecutiveInferenceFailures = 0;
let timerId = null;
let timeRemaining = 3600;
let monitoringPreparationInProgress = false;
let deviceChangeQueued = false;
const warningQueue = [];
const warningCooldowns = new Map();
const warningRecords = [];

const startButton = document.getElementById("startButton");
const initialDiv = document.getElementById("initialDiv");
const examSection = document.getElementById("examSection");
const examForm = document.getElementById("main-exam-form");
const submitButton = document.getElementById("submit-btn");
const video = document.getElementById("video-preview");
const statusElement = document.getElementById("camera-monitoring-status");
const examShell = document.querySelector(".main-exam-shell");
const cameraSelection = document.getElementById("camera-selection");
const cameraDeviceSelect = document.getElementById("camera-device-select");
const cameraSelectionHelp = document.getElementById("camera-selection-help");
const setupError = document.getElementById("monitoring-setup-error");
const setupErrorMessage = document.getElementById("monitoring-setup-error-message");
const retryMonitoringButton = document.getElementById("retry-monitoring-btn");
const warningModal = document.getElementById("monitoring-warning-modal");
const warningTitle = document.getElementById("monitoring-warning-title");
const warningMessage = document.getElementById("monitoring-warning-message");
const warningDismissButton = document.getElementById("monitoring-warning-dismiss");
const warningCountElement = document.getElementById("monitoring-warning-count");
const connectionMessage = document.getElementById("main-exam-connection-message");
const connectionMessageText = document.getElementById("main-exam-connection-message-text");
const retryIdentityButton = document.getElementById("retry-identity-verification-btn");
const retryIdentityWarningButton = document.getElementById("retry-identity-warning-btn");

function updateWarningCounter() {
    if (!warningCountElement) return;
    warningCountElement.textContent = `Warnings: ${warningCount} / ${MAX_WARNINGS}`;
    warningCountElement.dataset.state = warningCount >= MAX_WARNINGS ? "limit" : "active";
}

function responseHasJsonContentType(response) {
    const contentType = response.headers?.get("content-type") || "";
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    return mediaType === "application/json" || mediaType.endsWith("+json");
}

function getCsrfToken() {
    return document.querySelector("input[name='csrfmiddlewaretoken']")?.value
        || document.querySelector("meta[name='csrf-token']")?.content
        || "";
}

function responseDiagnostic(response, requestUrl, method) {
    return {
        method,
        requestUrl,
        finalUrl: response?.url || requestUrl,
        status: response?.status,
        contentType: response?.headers?.get("content-type") || "",
    };
}

async function requestJson(requestUrl, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");

    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("X-CSRFToken")) {
        const csrfToken = getCsrfToken();
        if (csrfToken) headers.set("X-CSRFToken", csrfToken);
    }

    let response;
    try {
        response = await fetch(requestUrl, {
            ...options,
            method,
            headers,
            credentials: "same-origin",
        });
    } catch (error) {
        console.error("Main Exam request network failure", {
            method,
            requestUrl,
            errorName: error?.name || "Error",
        });
        throw new Error(TEMPORARY_CONNECTION_MESSAGE);
    }

    const diagnostic = responseDiagnostic(response, requestUrl, method);
    if (!response.ok || !responseHasJsonContentType(response)) {
        console.error("Main Exam request did not return JSON", diagnostic);
        throw new Error(TEMPORARY_CONNECTION_MESSAGE);
    }

    try {
        return await response.json();
    } catch (error) {
        console.error("Main Exam JSON response parsing failed", diagnostic);
        throw new Error(TEMPORARY_CONNECTION_MESSAGE);
    }
}

function showConnectionIssue(showRetry = true) {
    if (connectionMessageText) connectionMessageText.textContent = TEMPORARY_CONNECTION_MESSAGE;
    if (connectionMessage) connectionMessage.hidden = false;
    if (retryIdentityButton) {
        retryIdentityButton.hidden = !showRetry;
        retryIdentityButton.disabled = false;
    }
}

function hideConnectionIssue() {
    if (connectionMessage) connectionMessage.hidden = true;
    if (retryIdentityButton) {
        retryIdentityButton.hidden = true;
        retryIdentityButton.disabled = false;
    }
}

function setStatus(message, state = "ready") {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.dataset.state = state;
}

function setExamInteractionEnabled(enabled) {
    if (examShell?.classList) examShell.classList.toggle("exam-monitoring-blocked", !enabled);

    document.querySelectorAll("#examSection input, #examSection button").forEach((control) => {
        control.disabled = !enabled;
    });

    document.querySelectorAll("#examSection .question-nav-item").forEach((item) => {
        item.setAttribute("aria-disabled", String(!enabled));
        item.tabIndex = enabled ? 0 : -1;
    });
}

function isStreamLive(stream = mediaStream) {
    const tracks = stream?.getVideoTracks?.() || [];
    return tracks.length > 0 && tracks.every((track) => track.readyState === "live") && stream.active !== false;
}

function isVideoReadyForMonitoring(stream = mediaStream) {
    return Boolean(
        isStreamLive(stream)
        && video
        && video.srcObject === stream
        && video.readyState >= 2
        && video.videoWidth > 0
        && video.videoHeight > 0
    );
}

function clearExamTimer() {
    if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
    }
}

function setMonitoringBlocked(message = MONITORING_BLOCKING_MESSAGE) {
    monitoringReady = false;
    monitoringActive = false;
    monitoringBlocked = true;
    setExamInteractionEnabled(false);
    showSetupError(message);
}

function showSetupError(message) {
    if (setupErrorMessage) setupErrorMessage.textContent = message;
    if (setupError) setupError.hidden = false;
    setStatus("Camera monitoring could not start", "error");
    if (startButton) {
        startButton.disabled = true;
        if (!examStarted) startButton.textContent = "Camera monitoring required";
    }
}

function hideSetupError() {
    if (setupError) setupError.hidden = true;
}

function stopCamera() {
    const stream = mediaStream || video?.srcObject;
    if (!stream) return;

    stream.getTracks().forEach((track) => {
        track.onended = null;
        track.onmute = null;
        track.stop();
    });

    mediaStream = null;
    if (video) {
        video.pause();
        video.srcObject = null;
        video.hidden = true;
    }
}

function stopMonitoringLoop() {
    if (monitoringLoopId !== null) {
        cancelAnimationFrame(monitoringLoopId);
        monitoringLoopId = null;
    }
}

function cleanupCameraAndMonitoring() {
    if (cleanupStarted) return;
    cleanupStarted = true;
    monitoringActive = false;
    monitoringBlocked = true;
    setExamInteractionEnabled(false);
    stopMonitoringLoop();
    clearExamTimer();
    stopCamera();
    setStatus("Camera monitoring stopped", "stopped");
}

function isCooldownActive(type, now) {
    const lastDismissedAt = warningCooldowns.get(type);
    return typeof lastDismissedAt === "number" && now - lastDismissedAt < WARNING_COOLDOWN_MS;
}

function enqueueWarning(type, durationMs, now = performance.now()) {
    if (!examStarted || cleanupStarted || warningTerminationStarted || !WARNING_RULES[type]) return false;
    if (isCooldownActive(type, now)) return false;
    if (activeWarning?.type === type || warningQueue.some((warning) => warning.type === type)) return false;

    warningCount += 1;
    updateWarningCounter();

    const warning = {
        type,
        timestamp: Date.now(),
        durationMs,
        warningNumber: warningCount,
    };
    warningRecords.push({
        eventType: warning.type,
        timestamp: new Date(warning.timestamp).toISOString(),
        durationMs: warning.durationMs,
        warningNumber: warning.warningNumber,
    });

    if (warningCount >= MAX_WARNINGS) {
        endExamForWarningLimit();
        return true;
    }

    warningQueue.push(warning);
    showNextWarning();
    return true;
}

function endExamForWarningLimit() {
    if (warningTerminationStarted) return;
    warningTerminationStarted = true;
    warningQueue.length = 0;
    activeWarning = null;
    cleanupCameraAndMonitoring();

    if (warningTitle) warningTitle.textContent = "Exam ended";
    if (warningMessage) {
        warningMessage.textContent =
            "Warning 3 of 3. Your exam has ended due to repeated monitoring violations.";
    }
    if (warningDismissButton) {
        warningDismissButton.hidden = true;
        warningDismissButton.disabled = true;
    }
    if (retryIdentityWarningButton) {
        retryIdentityWarningButton.hidden = true;
        retryIdentityWarningButton.disabled = true;
    }
    if (warningModal) {
        warningModal.hidden = false;
        warningModal.setAttribute("aria-modal", "true");
    }

    window.setTimeout(() => {
        if (config.dashboardUrl) window.location.assign(config.dashboardUrl);
    }, 4000);
}

function showNextWarning() {
    if (activeWarning || warningQueue.length === 0 || !warningModal || warningTerminationStarted) return;

    activeWarning = warningQueue.shift();
    const isIdentityMismatch = activeWarning.type === "identityMismatch";
    if (warningTitle) {
        warningTitle.textContent = isIdentityMismatch
            ? `Identity verification warning ${activeWarning.warningNumber} of ${MAX_WARNINGS}`
            : `Warning ${activeWarning.warningNumber} of ${MAX_WARNINGS}`;
    }
    warningMessage.textContent = isIdentityMismatch
        ? `${WARNING_RULES[activeWarning.type].message} Click “Retry identity verification” to try again. One more warning will end the exam.`
        : `${WARNING_RULES[activeWarning.type].message} One more warning will end the exam.`;
    warningDismissButton.hidden = isIdentityMismatch;
    warningDismissButton.disabled = isIdentityMismatch;
    if (retryIdentityWarningButton) {
        retryIdentityWarningButton.hidden = !isIdentityMismatch;
        retryIdentityWarningButton.disabled = false;
    }
    warningModal.setAttribute("aria-modal", "false");
    warningModal.hidden = false;
    warningDismissButton?.focus({ preventScroll: true });
}

function dismissWarning() {
    if (!activeWarning || warningTerminationStarted) return;

    warningCooldowns.set(activeWarning.type, performance.now());
    activeWarning = null;
    if (warningModal) warningModal.hidden = true;
    showNextWarning();
}

async function retryIdentityFromWarning() {
    if (
        !activeWarning ||
        activeWarning.type !== "identityMismatch" ||
        warningTerminationStarted ||
        !retryIdentityWarningButton
    ) return;

    activeWarning = null;
    warningModal.hidden = true;
    retryIdentityWarningButton.disabled = true;
    showNextWarning();

    try {
        hideConnectionIssue();
        await runIdentityVerification();
    } catch (error) {
        console.error("Identity verification failed", { errorName: error?.name || "Error" });
        showConnectionIssue(true);
    } finally {
        retryIdentityWarningButton.disabled = false;
    }
}

function updateCondition(type, isPresent, now) {
    const condition = conditionState[type];
    if (!condition) return;

    if (!isPresent) {
        condition.since = null;
        condition.warned = false;
        return;
    }

    if (condition.warned) return;

    if (condition.since === null) condition.since = now;
    const durationMs = now - condition.since;
    if (durationMs >= WARNING_RULES[type].durationMs) {
        condition.warned = enqueueWarning(type, durationMs, now);
    }
}

function getMatrixData(matrix) {
    if (!matrix) return null;
    const data = matrix.data || matrix;
    if (!data || typeof data.length !== "number" || data.length < 16) return null;
    return Array.from(data);
}

function estimateYawDegrees(landmarks, transformationMatrix) {
    const matrix = getMatrixData(transformationMatrix);
    if (matrix) {
        // MediaPipe returns a row-major 4x4 facial pose matrix. For the
        // rotation around the vertical axis, m02/m00 gives yaw. A 25-degree
        // threshold is intentionally above small tracking jitter and ordinary
        // movement.
        const yawRadians = Math.atan2(matrix[2], matrix[0]);
        const yawDegrees = Math.abs((yawRadians * 180) / Math.PI);
        if (Number.isFinite(yawDegrees)) return yawDegrees;
    }

    // Fallback documented pose estimate: compare the nose to the midpoint of
    // the outer eye landmarks, normalized by eye distance. A 0.35 ratio is
    // deliberately conservative so small landmark jitter is not a warning.
    if (!landmarks || landmarks.length < 264) return null;
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const nose = landmarks[1];
    const eyeDistance = Math.abs(rightEye.x - leftEye.x);
    if (!eyeDistance) return null;
    const eyeMidpoint = (leftEye.x + rightEye.x) / 2;
    return Math.abs((nose.x - eyeMidpoint) / eyeDistance) >= 0.35 ? 30 : 0;
}

function getBlendshapeScore(categories, name) {
    const category = categories?.find((item) => item.categoryName === name);
    return category ? category.score : null;
}

function eyesAreClosed(result) {
    const categories = result.faceBlendshapes?.[0]?.categories;
    if (!categories) return null;

    const leftBlink = getBlendshapeScore(categories, "eyeBlinkLeft");
    const rightBlink = getBlendshapeScore(categories, "eyeBlinkRight");
    if (leftBlink === null || rightBlink === null) return null;

    // Both eyes must be strongly closed for 1.5 seconds. This threshold is
    // intentionally conservative so a normal blink does not warn the user.
    return leftBlink >= 0.65 && rightBlink >= 0.65;
}

function checkMediaPipeCapabilities(result) {
    if (capabilitiesChecked) return true;

    if (!Array.isArray(result.faceBlendshapes) || !Array.isArray(result.facialTransformationMatrixes)) {
        throw new Error("This browser did not provide MediaPipe blendshape and facial-pose outputs.");
    }

    capabilitiesChecked = true;
    return true;
}

function processFaceResult(result, now) {
    checkMediaPipeCapabilities(result);

    const faceCount = result.faceLandmarks?.length || 0;
    updateCondition("noFace", faceCount === 0, now);
    updateCondition("multipleFaces", faceCount > 1, now);

    if (faceCount !== 1) {
        updateCondition("headTurned", false, now);
        updateCondition("eyesClosed", false, now);
        return;
    }

    const landmarks = result.faceLandmarks[0];
    const matrix = result.facialTransformationMatrixes?.[0];
    const yawDegrees = estimateYawDegrees(landmarks, matrix);
    const eyesClosed = eyesAreClosed(result);

    if (yawDegrees === null || eyesClosed === null) {
        throw new Error("MediaPipe returned no usable pose or eye-blendshape data.");
    }

    updateCondition("headTurned", yawDegrees > 25, now);
    updateCondition("eyesClosed", eyesClosed, now);
}

function handleMonitoringFailure(message, showWarning = true) {
    if (cameraStoppedIncidentActive && monitoringBlocked) return;
    cameraStoppedIncidentActive = true;
    stopMonitoringLoop();
    stopCamera();
    setMonitoringBlocked(message || MONITORING_BLOCKING_MESSAGE);
}

function scheduleInference() {
    if (!monitoringActive || !faceLandmarker || !video || cleanupStarted) return;
    monitoringLoopId = requestAnimationFrame(runInference);
}

function runInference(now) {
    monitoringLoopId = null;
    if (!monitoringActive || !faceLandmarker || !video || cleanupStarted) return;

    if (!isVideoReadyForMonitoring(mediaStream)) {
        handleMonitoringFailure(MONITORING_BLOCKING_MESSAGE);
        return;
    }

    if (now - lastInferenceAt >= INFERENCE_INTERVAL_MS && video.readyState >= 2) {
        lastInferenceAt = now;
        const timestampMs = Math.max(Math.round(now), lastVideoTimestamp + 1);
        lastVideoTimestamp = timestampMs;

        try {
            const result = faceLandmarker.detectForVideo(video, timestampMs);
            processFaceResult(result, now);
            consecutiveInferenceFailures = 0;
        } catch (error) {
            consecutiveInferenceFailures += 1;
            if (consecutiveInferenceFailures >= MAX_CONSECUTIVE_INFERENCE_FAILURES) {
                console.error("MediaPipe monitoring error after repeated inference failures", {
                    errorName: error?.name || "Error",
                });
                handleMonitoringFailure(MONITORING_BLOCKING_MESSAGE);
                return;
            }
        }
    }

    scheduleInference();
}

function attachStreamFailureHandlers(stream, attemptId) {
    const handleStreamFailure = () => {
        if (!cleanupStarted && mediaStream === stream && monitoringAttemptId === attemptId) {
            handleMonitoringFailure(MONITORING_BLOCKING_MESSAGE);
        }
    };

    stream.getTracks().forEach((track) => {
        track.onended = handleStreamFailure;
        track.onmute = handleStreamFailure;
    });

    stream.addEventListener("inactive", handleStreamFailure);
}

async function loadFaceLandmarker() {
    if (faceLandmarker) return;
    if (!config.mediapipePackageUrl || !config.mediapipeWasmUrl || !config.faceLandmarkerModelUrl) {
        throw new Error("MediaPipe monitoring configuration is missing.");
    }

    const visionModule = await import(config.mediapipePackageUrl);
    const { FaceLandmarker, FilesetResolver } = visionModule;
    if (!FaceLandmarker || !FilesetResolver) {
        throw new Error("The MediaPipe Tasks Vision package is unavailable.");
    }

    const vision = await FilesetResolver.forVisionTasks(config.mediapipeWasmUrl);
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: config.faceLandmarkerModelUrl,
            delegate: "CPU",
        },
        runningMode: "VIDEO",
        numFaces: 2,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
    });

    if (typeof faceLandmarker.detectForVideo !== "function") {
        throw new Error("This MediaPipe build does not support VIDEO mode.");
    }
}

function readableCameraLabel(device, index) {
    const label = String(device?.label || "").trim();
    return label || `Camera ${index + 1}`;
}

function renderCameraChoices(forceSelection = false) {
    if (!cameraDeviceSelect || !cameraSelection) return;

    cameraDeviceTokens = new Map();
    cameraDeviceSelect.replaceChildren();

    const showSelector = cameraDevices.length > 1 || forceSelection;
    cameraSelection.hidden = !showSelector;
    if (!showSelector) {
        cameraSelectionRequired = false;
        if (cameraDevices.length === 1) selectedDeviceId = cameraDevices[0].deviceId;
        return;
    }

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a camera";
    cameraDeviceSelect.appendChild(placeholder);

    cameraDevices.forEach((device, index) => {
        const token = `camera-${index + 1}`;
        cameraDeviceTokens.set(token, device.deviceId);
        const option = document.createElement("option");
        option.value = token;
        option.textContent = readableCameraLabel(device, index);
        cameraDeviceSelect.appendChild(option);
    });

    const selectedChoice = cameraDevices.find((device) => device.deviceId === selectedDeviceId);
    if (selectedChoice && !forceSelection) {
        const selectedIndex = cameraDevices.indexOf(selectedChoice);
        cameraDeviceSelect.value = `camera-${selectedIndex + 1}`;
        cameraSelectionRequired = false;
    } else {
        selectedDeviceId = null;
        cameraDeviceSelect.value = "";
        cameraSelectionRequired = true;
    }

    if (cameraSelectionHelp) {
        cameraSelectionHelp.textContent = cameraSelectionRequired
            ? "Select the camera that will be used for monitoring, then retry."
            : "This camera is used for the preview, monitoring, and identity verification image.";
    }
}

async function enumerateCameras(forceSelection = false) {
    if (!navigator.mediaDevices?.enumerateDevices) {
        throw new Error("This browser cannot enumerate cameras.");
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    cameraDevices = devices.filter((device) => device.kind === "videoinput");
    if (cameraDevices.length === 0) {
        renderCameraChoices(forceSelection);
        throw new Error("No video camera is available.");
    }

    renderCameraChoices(forceSelection);
    return cameraDevices;
}

async function requestCameraPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support camera access.");
    }

    if (cameraPermissionGranted) return;

    // This temporary permission probe is stopped before the selected-device
    // stream is created. It is only needed because labels are unavailable in
    // many browsers until camera permission has been granted.
    const permissionStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "user" } },
        audio: false,
    });
    permissionStream.getTracks().forEach((track) => track.stop());
    cameraPermissionGranted = true;
}

function withTimeout(promise, timeoutMs, message) {
    let timeoutId = null;
    const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
    });
}

function waitForVideoFrame(stream, attemptId) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + MONITORING_READINESS_TIMEOUT_MS;
        let settled = false;
        let timeoutId = null;

        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (timeoutId !== null) window.clearTimeout(timeoutId);
            if (error) reject(error);
            else resolve();
        };

        const check = () => {
            if (attemptId !== monitoringAttemptId || mediaStream !== stream) {
                finish(new Error("The camera setup attempt was replaced."));
                return;
            }
            if (!isStreamLive(stream)) {
                finish(new Error("The selected camera stream is not live."));
                return;
            }
            if (isVideoReadyForMonitoring(stream)) {
                finish();
                return;
            }
            if (Date.now() >= deadline) {
                finish(new Error("The camera did not produce a video frame."));
                return;
            }
            window.setTimeout(check, 50);
        };

        timeoutId = window.setTimeout(() => {
            finish(new Error("The camera did not produce a video frame."));
        }, MONITORING_READINESS_TIMEOUT_MS);
        check();
    });
}

async function startSelectedCamera(attemptId) {
    if (!selectedDeviceId || cameraSelectionRequired) {
        throw new Error("A monitoring camera must be selected.");
    }

    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            deviceId: { exact: selectedDeviceId },
        },
        audio: false,
    });

    if (attemptId !== monitoringAttemptId) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("The camera setup attempt was replaced.");
    }

    mediaStream = stream;
    attachStreamFailureHandlers(stream, attemptId);
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    await waitForVideoFrame(stream, attemptId);
    return stream;
}

async function verifySelectedStream(attemptId) {
    if (attemptId !== monitoringAttemptId || !isVideoReadyForMonitoring(mediaStream)) {
        throw new Error("The selected camera is not ready for monitoring.");
    }

    const timestampMs = Math.max(1, Math.round(performance.now()));
    const result = faceLandmarker.detectForVideo(video, timestampMs);
    checkMediaPipeCapabilities(result);
    lastVideoTimestamp = timestampMs;
}

async function prepareMonitoring() {
    const attemptId = monitoringAttemptId + 1;
    const readinessDeadline = Date.now() + MONITORING_READINESS_TIMEOUT_MS;
    monitoringAttemptId = attemptId;
    monitoringPreparationInProgress = true;
    cleanupStarted = false;
    monitoringReady = false;
    monitoringActive = false;
    monitoringBlocked = true;
    capabilitiesChecked = false;
    cameraStoppedIncidentActive = false;
    consecutiveInferenceFailures = 0;
    stopMonitoringLoop();
    stopCamera();
    setExamInteractionEnabled(false);
    if (startButton && !examStarted) {
        startButton.disabled = true;
        startButton.textContent = "Preparing camera monitoring...";
    }
    hideSetupError();
    setStatus("Checking camera...", "loading");
    if (cameraDeviceSelect) cameraDeviceSelect.disabled = true;
    Object.values(conditionState).forEach((condition) => {
        condition.since = null;
        condition.warned = false;
    });

    try {
        const remainingTimeout = () => Math.max(1, readinessDeadline - Date.now());
        await withTimeout(requestCameraPermission(), remainingTimeout(), MONITORING_BLOCKING_MESSAGE);
        await withTimeout(enumerateCameras(), remainingTimeout(), MONITORING_BLOCKING_MESSAGE);
        if (cameraSelectionRequired || !selectedDeviceId) {
            throw new Error("A monitoring camera must be selected.");
        }

        setStatus("Loading monitoring engine...", "loading");
        await withTimeout(loadFaceLandmarker(), remainingTimeout(), MONITORING_BLOCKING_MESSAGE);
        setStatus("Checking camera...", "loading");
        await withTimeout(startSelectedCamera(attemptId), remainingTimeout(), MONITORING_BLOCKING_MESSAGE);
        await withTimeout(verifySelectedStream(attemptId), remainingTimeout(), MONITORING_BLOCKING_MESSAGE);

        monitoringReady = true;
        monitoringBlocked = false;
        cameraStoppedIncidentActive = false;
        if (examStarted) {
            monitoringActive = true;
            setExamInteractionEnabled(true);
            setStatus("Camera monitoring is active", "active");
            monitoringLoopId = requestAnimationFrame(runInference);
        } else {
            setStatus("Camera monitoring is ready", "ready");
            startButton.disabled = false;
            startButton.textContent = "Start Exam";
        }
        hideSetupError();
    } catch (error) {
        if (attemptId !== monitoringAttemptId) return;
        console.error("Camera monitoring setup error", { errorName: error?.name || "Error" });
        if (["NotAllowedError", "SecurityError", "NotFoundError", "OverconstrainedError"].includes(error?.name)) {
            cameraPermissionGranted = false;
        }
        stopMonitoringLoop();
        stopCamera();
        setMonitoringBlocked(MONITORING_BLOCKING_MESSAGE);
    } finally {
        if (attemptId === monitoringAttemptId) {
            monitoringPreparationInProgress = false;
            if (cameraDeviceSelect) cameraDeviceSelect.disabled = false;
            if (deviceChangeQueued) {
                deviceChangeQueued = false;
                handleDeviceChange();
            }
        }
    }
}

async function handleDeviceChange() {
    if (cleanupStarted) return;
    if (monitoringPreparationInProgress) {
        deviceChangeQueued = true;
        return;
    }

    const previousSelectedDeviceId = selectedDeviceId;
    const previousDeviceCount = cameraDevices.length;
    try {
        const devices = await enumerateCameras(
            Boolean(examStarted && previousSelectedDeviceId && !cameraDevices.some((device) => device.deviceId === previousSelectedDeviceId))
        );
        const selectedStillExists = Boolean(
            previousSelectedDeviceId && devices.some((device) => device.deviceId === previousSelectedDeviceId)
        );

        if (previousSelectedDeviceId && !selectedStillExists) {
            selectedDeviceId = null;
            renderCameraChoices(true);
            if (examStarted) {
                handleMonitoringFailure(MONITORING_BLOCKING_MESSAGE);
            } else {
                stopCamera();
                setMonitoringBlocked(MONITORING_BLOCKING_MESSAGE);
            }
            return;
        }

        if (!examStarted && previousDeviceCount <= 1 && devices.length > 1) {
            stopCamera();
            selectedDeviceId = null;
            renderCameraChoices(true);
            setMonitoringBlocked(MONITORING_BLOCKING_MESSAGE);
        }
    } catch (error) {
        console.error("Camera device enumeration failed", { errorName: error?.name || "Error" });
        handleMonitoringFailure(MONITORING_BLOCKING_MESSAGE);
    }
}

function handleCameraSelectionChange() {
    const nextDeviceId = cameraDeviceTokens.get(cameraDeviceSelect?.value);
    if (!nextDeviceId) {
        selectedDeviceId = null;
        cameraSelectionRequired = true;
        stopMonitoringLoop();
        stopCamera();
        setMonitoringBlocked(MONITORING_BLOCKING_MESSAGE);
        return;
    }

    selectedDeviceId = nextDeviceId;
    cameraSelectionRequired = false;
    prepareMonitoring();
}

async function captureIdentityImageFromExistingStream() {
    if (!mediaStream || !video || video.readyState < 2) {
        throw new Error("The camera preview is not ready for identity verification.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) throw new Error("The camera did not provide an image.");

    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg"));
    if (!blob) throw new Error("The camera image could not be captured.");

    const formData = new FormData();
    formData.append("captured_image", blob, "image.jpg");

    if (!config.identityVerificationUrl) {
        throw new Error(IDENTITY_VERIFICATION_RESPONSE_ERROR);
    }

    const data = await requestJson(config.identityVerificationUrl, {
        method: "POST",
        body: formData,
    });
    return handleIdentityVerificationResult(data);
}

function handleIdentityVerificationResult(data) {
    if (data?.success === true) return "match";
    if (data?.code === "identity_mismatch") {
        enqueueWarning("identityMismatch", 0);
        return "mismatch";
    }
    throw new Error(IDENTITY_VERIFICATION_RESPONSE_ERROR);
}

async function runIdentityVerification() {
    const result = await captureIdentityImageFromExistingStream();
    if (result === "match") {
        hideConnectionIssue();
        return result;
    }

    return result;
}

async function verifyIdentityAndHandleFailure() {
    if (!retryIdentityButton || retryIdentityButton.disabled) return;
    hideConnectionIssue();
    retryIdentityButton.disabled = true;
    try {
        await runIdentityVerification();
    } catch (error) {
        console.error("Identity verification failed", { errorName: error?.name || "Error" });
        showConnectionIssue(true);
    } finally {
        retryIdentityButton.disabled = false;
    }
}

function startExam() {
    if (!monitoringReady || monitoringBlocked || !isVideoReadyForMonitoring(mediaStream)) {
        stopMonitoringLoop();
        stopCamera();
        setMonitoringBlocked(MONITORING_BLOCKING_MESSAGE);
        return;
    }

    hideConnectionIssue();
    examStarted = true;
    monitoringActive = true;
    setExamInteractionEnabled(true);
    setStatus("Camera monitoring active", "active");
    initialDiv.hidden = true;
    examSection.hidden = false;
    monitoringLoopId = requestAnimationFrame(runInference);
    startTimer();

    runIdentityVerification().catch((error) => {
        console.error("Identity verification failed", { errorName: error?.name || "Error" });
        showConnectionIssue(true);
    });
}

function initializeQuestionNavigation() {
    const navItems = [...document.querySelectorAll(".question-nav-item")];
    const questionCards = [...document.querySelectorAll(".question-card")];

    const showQuestion = (item) => {
        const targetId = item.dataset.target?.slice(1);
        questionCards.forEach((card) => card.classList.toggle("active", card.id === targetId));
        navItems.forEach((navItem) => navItem.classList.toggle("active", navItem === item));
    };

    navItems.forEach((item) => item.addEventListener("click", (event) => {
        event.preventDefault();
        showQuestion(item);
    }));
    if (navItems[0]) showQuestion(navItems[0]);

    document.querySelectorAll(".form-check-input").forEach((input) => {
        input.addEventListener("change", () => {
            const questionId = input.name.split("_")[1];
            const navItem = document.querySelector(`.question-nav-item[data-id="${questionId}"]`);
            navItem?.classList.add("answered");
            navItem?.classList.remove("unanswered");
        });
    });
}

function startTimer() {
    const timerElement = document.querySelector(".timer");
    if (!timerElement || timerId !== null) return;

    const updateTimer = () => {
        if (timeRemaining <= 0) {
            timerElement.textContent = "Time End In - 00:00";
            cleanupCameraAndMonitoring();
            window.location.assign(config.dashboardUrl);
            return;
        }

        const minutes = String(Math.floor(timeRemaining / 60)).padStart(2, "0");
        const seconds = String(timeRemaining % 60).padStart(2, "0");
        timerElement.textContent = `Time End In - ${minutes}:${seconds}`;
        timeRemaining -= 1;
    };

    updateTimer();
    timerId = window.setInterval(() => {
        if (cleanupStarted) {
            clearExamTimer();
            return;
        }
        if (!examStarted || monitoringBlocked || !monitoringActive) return;
        updateTimer();
    }, 1000);
}

function initializeSubmission() {
    examForm.addEventListener("submit", (event) => {
        if (submissionStarted || monitoringBlocked || !monitoringReady || !monitoringActive) {
            event.preventDefault();
            return;
        }

        submissionStarted = true;
        submitButton.disabled = true;
        cleanupCameraAndMonitoring();

        // Allow the browser to perform the normal POST to the Django form action.
    });
}

retryMonitoringButton.addEventListener("click", () => {
    prepareMonitoring();
});

cameraDeviceSelect?.addEventListener("change", handleCameraSelectionChange);

if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
}

warningDismissButton.addEventListener("click", dismissWarning);
retryIdentityButton?.addEventListener("click", verifyIdentityAndHandleFailure);
retryIdentityWarningButton?.addEventListener("click", retryIdentityFromWarning);
startButton.addEventListener("click", startExam);

window.addEventListener("pagehide", cleanupCameraAndMonitoring, { once: true });
window.addEventListener("beforeunload", cleanupCameraAndMonitoring, { once: true });

document.addEventListener("DOMContentLoaded", () => {
    initializeQuestionNavigation();
    initializeSubmission();
    setExamInteractionEnabled(false);
    prepareMonitoring();
});
