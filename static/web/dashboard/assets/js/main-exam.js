const config = window.MAIN_EXAM_CONFIG || {};

const WARNING_COOLDOWN_MS = 8000;
const INFERENCE_INTERVAL_MS = 100;
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
};

const conditionState = Object.fromEntries(
    Object.keys(WARNING_RULES)
        .filter((type) => type !== "cameraStopped")
        .map((type) => [type, { since: null }])
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
const setupError = document.getElementById("monitoring-setup-error");
const setupErrorMessage = document.getElementById("monitoring-setup-error-message");
const retryMonitoringButton = document.getElementById("retry-monitoring-btn");
const warningModal = document.getElementById("monitoring-warning-modal");
const warningMessage = document.getElementById("monitoring-warning-message");
const warningDismissButton = document.getElementById("monitoring-warning-dismiss");

function setStatus(message, state = "ready") {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.dataset.state = state;
}

function showSetupError(message) {
    if (setupErrorMessage) setupErrorMessage.textContent = message;
    if (setupError) setupError.hidden = false;
    setStatus("Camera monitoring setup required", "error");
    if (startButton && !examStarted) {
        startButton.disabled = true;
        startButton.textContent = "Camera monitoring required";
    }
}

function hideSetupError() {
    if (setupError) setupError.hidden = true;
}

function stopCamera() {
    if (!mediaStream) return;

    mediaStream.getTracks().forEach((track) => {
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
    stopMonitoringLoop();
    stopCamera();
    setStatus("Camera monitoring stopped", "stopped");
}

function isCooldownActive(type, now) {
    const lastDismissedAt = warningCooldowns.get(type);
    return typeof lastDismissedAt === "number" && now - lastDismissedAt < WARNING_COOLDOWN_MS;
}

function enqueueWarning(type, durationMs, now = performance.now()) {
    if (!examStarted || cleanupStarted || !WARNING_RULES[type]) return;
    if (isCooldownActive(type, now)) return;
    if (activeWarning?.type === type || warningQueue.some((warning) => warning.type === type)) return;

    warningQueue.push({
        type,
        timestamp: Date.now(),
        durationMs,
    });
    showNextWarning();
}

function showNextWarning() {
    if (activeWarning || warningQueue.length === 0 || !warningModal) return;

    activeWarning = warningQueue.shift();
    warningRecords.push({
        eventType: activeWarning.type,
        timestamp: new Date(activeWarning.timestamp).toISOString(),
        durationMs: activeWarning.durationMs,
    });
    warningMessage.textContent = WARNING_RULES[activeWarning.type].message;
    warningModal.hidden = false;
    warningDismissButton?.focus({ preventScroll: true });
}

function dismissWarning() {
    if (!activeWarning) return;

    warningCooldowns.set(activeWarning.type, performance.now());
    activeWarning = null;
    if (warningModal) warningModal.hidden = true;
    showNextWarning();
}

function updateCondition(type, isPresent, now) {
    const condition = conditionState[type];
    if (!condition) return;

    if (!isPresent) {
        condition.since = null;
        return;
    }

    if (condition.since === null) condition.since = now;
    const durationMs = now - condition.since;
    if (durationMs >= WARNING_RULES[type].durationMs) {
        enqueueWarning(type, durationMs, now);
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
    monitoringActive = false;
    stopMonitoringLoop();
    stopCamera();
    setStatus("Camera monitoring stopped", "error");
    showSetupError(message);
    if (showWarning && examStarted) enqueueWarning("cameraStopped", 0);
}

function scheduleInference() {
    if (!monitoringActive || !faceLandmarker || !video || cleanupStarted) return;
    monitoringLoopId = requestAnimationFrame(runInference);
}

function runInference(now) {
    monitoringLoopId = null;
    if (!monitoringActive || !faceLandmarker || !video || cleanupStarted) return;

    if (now - lastInferenceAt >= INFERENCE_INTERVAL_MS && video.readyState >= 2) {
        lastInferenceAt = now;
        const timestampMs = Math.max(Math.round(now), lastVideoTimestamp + 1);
        lastVideoTimestamp = timestampMs;

        try {
            const result = faceLandmarker.detectForVideo(video, timestampMs);
            processFaceResult(result, now);
        } catch (error) {
            console.error("MediaPipe monitoring error:", error);
            handleMonitoringFailure("MediaPipe monitoring stopped. Please retry camera monitoring setup.");
            return;
        }
    }

    scheduleInference();
}

function attachStreamFailureHandlers(stream) {
    stream.getTracks().forEach((track) => {
        track.onended = () => {
            if (!cleanupStarted) handleMonitoringFailure("Camera monitoring stopped. Please reconnect or allow camera access.");
        };
        track.onmute = () => {
            if (!cleanupStarted) handleMonitoringFailure("Camera monitoring stopped. Please reconnect or allow camera access.");
        };
    });

    stream.addEventListener("inactive", () => {
        if (!cleanupStarted) handleMonitoringFailure("Camera monitoring stopped. Please reconnect or allow camera access.");
    });
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

async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support camera access.");
    }

    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    mediaStream = stream;
    attachStreamFailureHandlers(stream);

    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    if (video.readyState < 2) {
        await new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => reject(new Error("The camera did not produce a video frame.")), 5000);
            video.addEventListener("loadeddata", () => {
                window.clearTimeout(timeoutId);
                resolve();
            }, { once: true });
        });
    }
}

async function prepareMonitoring() {
    cleanupStarted = false;
    monitoringReady = false;
    monitoringActive = false;
    capabilitiesChecked = false;
    Object.values(conditionState).forEach((condition) => {
        condition.since = null;
    });
    hideSetupError();
    setStatus("Preparing camera monitoring...", "loading");

    try {
        await loadFaceLandmarker();
        await startCamera();
        const capabilityProbe = faceLandmarker.detectForVideo(video, Math.max(1, Math.round(performance.now())));
        checkMediaPipeCapabilities(capabilityProbe);
        monitoringReady = true;
        if (examStarted) {
            monitoringActive = true;
            setStatus("Camera monitoring active", "active");
            monitoringLoopId = requestAnimationFrame(runInference);
        } else {
            setStatus("Camera monitoring ready", "ready");
            startButton.disabled = false;
            startButton.textContent = "Start Exam";
        }
    } catch (error) {
        console.error("Camera monitoring setup error:", error);
        stopMonitoringLoop();
        stopCamera();
        showSetupError(error.message || "Camera monitoring could not be started.");
    }
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
    const csrfToken = document.querySelector("input[name='csrfmiddlewaretoken']")?.value
        || document.querySelector("meta[name='csrf-token']")?.content;

    const response = await fetch(config.identityVerificationUrl, {
        method: "POST",
        headers: csrfToken ? { "X-CSRFToken": csrfToken } : {},
        body: formData,
    });
    const data = await response.json();
    if (!data.success) throw new Error(data.message || "Candidate identity verification failed.");
}

function startExam() {
    if (!monitoringReady || !mediaStream) return;

    examStarted = true;
    monitoringActive = true;
    setStatus("Camera monitoring active", "active");
    initialDiv.hidden = true;
    examSection.hidden = false;
    monitoringLoopId = requestAnimationFrame(runInference);

    captureIdentityImageFromExistingStream().catch((error) => {
        console.error("Identity verification error:", error);
        window.alert(error.message || "User verification failed. Your attempt will be redirected.");
        cleanupCameraAndMonitoring();
        window.location.assign(config.dashboardUrl);
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
    let timeRemaining = 3600;

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
    const timerId = window.setInterval(() => {
        if (cleanupStarted) {
            window.clearInterval(timerId);
            return;
        }
        updateTimer();
    }, 1000);
}

function initializeSubmission() {
    examForm.addEventListener("submit", (event) => {
        if (submissionStarted) {
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

warningDismissButton.addEventListener("click", dismissWarning);
startButton.addEventListener("click", startExam);

window.addEventListener("pagehide", cleanupCameraAndMonitoring, { once: true });
window.addEventListener("beforeunload", cleanupCameraAndMonitoring, { once: true });

document.addEventListener("DOMContentLoaded", () => {
    initializeQuestionNavigation();
    initializeSubmission();
    startTimer();
    prepareMonitoring();
});
