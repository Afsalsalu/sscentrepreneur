const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const mainExamPath = "static/web/dashboard/assets/js/main-exam.js";
const templatePath = "templates/web/exam/main_exam.html";
const source = fs.readFileSync(mainExamPath, "utf8");
const template = fs.readFileSync(templatePath, "utf8");

assert.strictEqual((source.match(/response\.json\(\)/g) || []).length, 1);
assert.doesNotMatch(source, /window\.alert\(/);
assert.doesNotMatch(source, /\/(?:exam|capture_image|main-exam)\//);
assert.match(template, /data-identity-verification-url="\{% url 'exam:capture_image' %\}"/);

const helperStart = source.indexOf("function responseHasJsonContentType");
const helperEnd = source.indexOf("function showConnectionIssue", helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, "request helper boundaries not found");

const helperContext = {
    console,
    Headers,
    TEMPORARY_CONNECTION_MESSAGE: "A temporary connection issue occurred. Please continue your exam or try again.",
    document: {
        querySelector() {
            return { value: "csrf-token" };
        },
    },
};
vm.createContext(helperContext);
vm.runInContext(
    `const TEMPORARY_CONNECTION_MESSAGE = ${JSON.stringify(helperContext.TEMPORARY_CONNECTION_MESSAGE)};\n` +
    `${source.slice(helperStart, helperEnd)}\nglobalThis.requestJsonForTest = requestJson;`,
    helperContext
);

let nextResponse;
let lastRequestOptions;
helperContext.fetch = async (url, options) => {
    lastRequestOptions = { url, options };
    return nextResponse;
};

function response(status, contentType, body) {
    let jsonCalls = 0;
    return {
        ok: status >= 200 && status < 300,
        status,
        url: "https://sscentrepreneur.com/test/exam/capture_image/",
        headers: { get: () => contentType },
        get jsonCalls() { return jsonCalls; },
        async json() {
            jsonCalls += 1;
            return JSON.parse(body);
        },
    };
}

(async () => {
    for (const [status, contentType] of [
        [200, "text/html"],
        [302, "text/html"],
        [403, "text/html"],
        [404, "text/html"],
        [500, "text/html"],
    ]) {
        nextResponse = response(status, contentType, "<!doctype html>");
        await assert.rejects(
            helperContext.requestJsonForTest("/test/exam/capture_image/", { method: "POST" }),
            /temporary connection issue/
        );
        assert.strictEqual(nextResponse.jsonCalls, 0, `response.json called for HTTP ${status}`);
    }

    nextResponse = response(201, "application/json; charset=utf-8", '{"success":true}');
    const data = await helperContext.requestJsonForTest("/test/exam/capture_image/", { method: "POST" });
    assert.deepStrictEqual({ ...data }, { success: true });
    assert.strictEqual(nextResponse.jsonCalls, 1);
    assert.strictEqual(lastRequestOptions.options.credentials, "same-origin");
    assert.strictEqual(lastRequestOptions.options.headers.get("Accept"), "application/json");
    assert.strictEqual(lastRequestOptions.options.headers.get("X-CSRFToken"), "csrf-token");

    const warningElements = new Map();
    const makeElement = (id) => {
        const element = {
            id,
            hidden: false,
            disabled: false,
            textContent: "",
            dataset: {},
            srcObject: null,
            pause() {},
            setAttribute(name, value) { this[name] = value; },
            addEventListener() {},
            focus() {},
        };
        warningElements.set(id, element);
        return element;
    };
    [
        "startButton", "initialDiv", "examSection", "main-exam-form", "submit-btn", "video-preview",
        "camera-monitoring-status", "monitoring-setup-error", "monitoring-setup-error-message",
        "retry-monitoring-btn", "monitoring-warning-modal", "monitoring-warning-title",
        "monitoring-warning-message", "monitoring-warning-dismiss", "monitoring-warning-count",
        "main-exam-connection-message", "main-exam-connection-message-text",
        "retry-identity-verification-btn",
    ].forEach(makeElement);

    const warningCallbacks = [];
    let redirectCount = 0;
    let stoppedTracks = 0;
    const warningStream = {
        getTracks: () => [{ stop() { stoppedTracks += 1; } }],
    };
    const warningContext = {
        console,
        Date,
        Math,
        Map,
        Object,
        Promise,
        Error,
        Headers,
        FormData,
        performance: { now: () => 0 },
        window: {
            setTimeout(callback) { warningCallbacks.push(callback); return warningCallbacks.length; },
            clearTimeout() {},
            setInterval() { return 1; },
            clearInterval() {},
            requestAnimationFrame() { return 1; },
            cancelAnimationFrame() {},
            location: { assign() { redirectCount += 1; } },
            addEventListener() {},
        },
        document: {
            body: { dataset: {
                dashboardUrl: "/test/exam/dashboard/",
                identityVerificationUrl: "/test/exam/capture_image/",
            } },
            getElementById(id) { return warningElements.get(id) || null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            addEventListener() {},
        },
        navigator: {},
        requestAnimationFrame() { return 1; },
        cancelAnimationFrame() {},
        stream: warningStream,
    };
    warningContext.window.document = warningContext.document;
    vm.createContext(warningContext);
    vm.runInContext(`${source}\nexamStarted = true;\nmediaStream = stream;\nmonitoringActive = true;\nglobalThis.warningTest = {\n  updateCondition,\n  dismissWarning,\n  handleMonitoringFailure,\n  state: () => ({ count: warningCount, title: warningTitle.textContent, message: warningMessage.textContent, active: monitoringActive, cleanup: cleanupStarted })\n};`, warningContext);

    warningContext.warningTest.updateCondition("noFace", true, 0);
    warningContext.warningTest.updateCondition("noFace", true, 3000);
    assert.strictEqual(warningContext.warningTest.state().count, 1);
    assert.strictEqual(warningElements.get("monitoring-warning-count").textContent, "Warnings: 1 / 3");
    assert.match(warningContext.warningTest.state().title, /Warning 1 of 3/);
    assert.strictEqual(redirectCount, 0);
    warningContext.warningTest.updateCondition("noFace", true, 12000);
    assert.strictEqual(warningContext.warningTest.state().count, 1);
    warningContext.warningTest.dismissWarning();

    warningContext.warningTest.updateCondition("multipleFaces", true, 0);
    warningContext.warningTest.updateCondition("multipleFaces", true, 1000);
    assert.strictEqual(warningContext.warningTest.state().count, 2);
    assert.strictEqual(warningElements.get("monitoring-warning-count").textContent, "Warnings: 2 / 3");
    assert.match(warningContext.warningTest.state().title, /Warning 2 of 3/);
    assert.strictEqual(redirectCount, 0);
    warningContext.warningTest.dismissWarning();

    warningContext.warningTest.handleMonitoringFailure("Camera stopped");
    assert.strictEqual(warningContext.warningTest.state().count, 3);
    assert.strictEqual(warningElements.get("monitoring-warning-count").textContent, "Warnings: 3 / 3");
    assert.strictEqual(
        warningContext.warningTest.state().message,
        "Warning 3 of 3. Your exam has ended due to repeated monitoring violations."
    );
    assert.strictEqual(warningContext.warningTest.state().active, false);
    assert.strictEqual(warningContext.warningTest.state().cleanup, true);
    assert.strictEqual(stoppedTracks, 1);
    warningContext.warningTest.handleMonitoringFailure("Camera stopped again");
    warningCallbacks.forEach((callback) => callback());
    assert.strictEqual(redirectCount, 1);

    console.log("main exam JSON safety tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
