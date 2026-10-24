package dev.protoflow.driver;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.accessibilityservice.AccessibilityServiceInfo;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.UiScrollable;
import androidx.test.uiautomator.UiSelector;
import androidx.test.uiautomator.Until;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.regex.Pattern;

/*
 * ProtoFlow Android capture. One run = one scene: launch the target app on a screen, replay the anchor steps, then
 * write the raw accessibility tree and a device screenshot. The Node driver (scripts/android-driver.js) normalises the
 * raw tree (src/drivers/android-tree.js), so this file stays a thin, platform-only layer.
 *
 * Input: instrumentation argument `job` = base64 JSON { package, activity?, launchUrl?, screen, extras, steps, timeoutMs,
 * launchTimeoutMs, probeInsets }. Output (app files dir): out/raw.json and out/device.png.
 */
@RunWith(AndroidJUnit4.class)
public class CaptureTest {
    private Instrumentation instrumentation;
    private UiDevice device;
    private String targetPackage;

    @Test
    public void capture() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        Context context = instrumentation.getTargetContext();
        File out = new File(context.getFilesDir(), "out");
        deleteRecursively(out);
        out.mkdirs();
        JSONObject result = new JSONObject();
        try {
            JSONObject job = new JSONObject(new String(Base64.decode(InstrumentationRegistry.getArguments().getString("job"), Base64.DEFAULT), StandardCharsets.UTF_8));
            result = run(job, context, out);
        } catch (Exception error) {
            result.put("status", "FAIL").put("reason", "capture error: " + error);
        } finally {
            try (FileOutputStream stream = new FileOutputStream(new File(out, "raw.json"))) {
                stream.write(result.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
    }

    private JSONObject run(JSONObject job, Context context, File out) throws Exception {
        targetPackage = job.getString("package");
        long timeout = job.optLong("timeoutMs", 10000);
        long launchTimeout = job.optLong("launchTimeoutMs", 60000);
        UiAutomation automation = instrumentation.getUiAutomation();
        // Report every view and its resource id, not only the ones TalkBack would read (React Native views).
        AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        automation.setServiceInfo(info);

        JSONObject result = new JSONObject();
        DisplayMetrics metrics = new DisplayMetrics();
        ((WindowManager) context.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(metrics);
        result.put("density", metrics.density);
        result.put("screen", new JSONObject().put("width", metrics.widthPixels).put("height", metrics.heightPixels));
        if (job.optBoolean("probeInsets")) {
            ProbeActivity.insets = null;
            try (ActivityScenario<ProbeActivity> scenario = ActivityScenario.launch(ProbeActivity.class)) {
                long deadline = SystemClock.uptimeMillis() + timeout;
                while (ProbeActivity.insets == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50);
                Insets insets = ProbeActivity.insets;
                if (insets != null) result.put("insets", new JSONObject().put("left", insets.left).put("top", insets.top).put("right", insets.right).put("bottom", insets.bottom));
            }
        }

        Intent intent;
        // Deep-link apps (Expo Router) open the route the URL names; the extras still ride along.
        if (job.has("launchUrl")) intent = new Intent(Intent.ACTION_VIEW, Uri.parse(job.getString("launchUrl"))).setPackage(targetPackage);
        else if (job.has("activity")) intent = new Intent().setClassName(targetPackage, job.getString("activity"));
        else intent = context.getPackageManager().getLaunchIntentForPackage(targetPackage);
        if (intent == null) return result.put("status", "FAIL").put("reason", "package " + targetPackage + " has no launcher activity");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        JSONObject extras = job.optJSONObject("extras");
        if (extras != null) for (Iterator<String> keys = extras.keys(); keys.hasNext(); ) { String key = keys.next(); intent.putExtra(key, extras.getString(key)); }
        device.executeShellCommand("am force-stop " + targetPackage);
        context.startActivity(intent);
        if (!device.wait(Until.hasObject(By.pkg(targetPackage).depth(0)), launchTimeout)) return failure(result, out, "app " + targetPackage + " did not reach the foreground");
        String screen = job.getString("screen");
        if (!device.wait(Until.hasObject(anchor(screen)), launchTimeout)) return failure(result, out, "screen anchor " + screen + " did not appear (does the app honour " + (job.has("launchUrl") ? "the launch URL " + job.getString("launchUrl") : "the PROTOFLOW_SCREEN extra") + "?)");
        // The first frame can be on screen before the app accepts input; replay steps on an idle UI.
        device.waitForIdle();
        SystemClock.sleep(500);

        JSONArray steps = job.optJSONArray("steps");
        for (int index = 0; steps != null && index < steps.length(); index++) {
            JSONObject step = steps.getJSONObject(index);
            String reason = perform(step, step.optLong("timeoutMs", timeout));
            if (reason != null) return failure(result, out, "step " + (index + 1) + " " + step.getString("action") + " " + step.optString("anchor", "") + ": " + reason);
        }
        device.waitForIdle();
        SystemClock.sleep(300);
        boolean keyboard = keyboardVisible(automation);
        result.put("keyboardVisible", keyboard);
        // A state that ends while typing may keep the keyboard up; the engine leaves its frame out of the comparison.
        Rect ime = keyboard ? imeBounds(automation) : null;
        if (ime != null) result.put("keyboardFrame", new JSONObject().put("left", ime.left).put("top", ime.top).put("right", ime.right).put("bottom", ime.bottom));
        result.put("tree", stableTree(automation));
        if (!screenshot(automation, new File(out, "device.png"))) return result.put("status", "FAIL").put("reason", "screenshot failed");
        return result.put("status", "PASS").put("screenshot", "device.png");
    }

    /** Compose testTag / React Native testID / Flutter identifier as-is, or a view id with the reversible transform. */
    private BySelector anchor(String id) {
        String view = id.replace("-", "_").replace(".", "__");
        return By.pkg(targetPackage).res(Pattern.compile("(.*:id/)?(" + Pattern.quote(id) + "|" + Pattern.quote(view) + ")"));
    }

    private String perform(JSONObject step, long timeout) throws Exception {
        String action = step.getString("action");
        if (action.equals("back")) { device.pressBack(); return null; }
        String id = step.optString("anchor", null);
        if (id == null) return "step has no anchor";
        UiObject2 target = device.wait(Until.findObject(anchor(id)), timeout);
        if (target == null && !action.equals("scroll-to")) return "anchor " + id + " not found";
        if (target != null) target = settled(id, target);
        switch (action) {
            case "wait-for": return null;
            case "tap": target.click(); return null;
            case "toggle": {
                UiObject2 control = target.isCheckable() ? target : target.findObject(By.checkable(true));
                (control != null ? control : target).click();
                return null;
            }
            case "clear": target.clear(); return null;
            case "fill": return type(target, step.optString("value", ""));
            case "select": {
                target.click();
                UiObject2 option = device.wait(Until.findObject(By.text(step.optString("value", ""))), timeout);
                if (option == null) return "option " + step.optString("value", "") + " not found";
                option.click();
                return null;
            }
            case "scroll-to": {
                String view = id.replace("-", "_").replace(".", "__");
                boolean found = new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().resourceIdMatches("(.*:id/)?(" + Pattern.quote(id) + "|" + Pattern.quote(view) + ")"));
                return found ? null : "anchor " + id + " is not reachable by scrolling";
            }
            default: return "unsupported action";
        }
    }

    /**
     * The target once its bounds hold still. A previous step can start a layout animation (the keyboard hiding
     * resizes the window), and a click on bounds read mid-animation lands on whatever moved there.
     */
    private UiObject2 settled(String id, UiObject2 target) {
        device.waitForIdle();
        long deadline = SystemClock.uptimeMillis() + 2000;
        android.graphics.Rect previous = null;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 current = device.findObject(anchor(id));
            if (current == null) return target;
            android.graphics.Rect bounds = current.getVisibleBounds();
            if (bounds.equals(previous)) return current;
            previous = bounds;
            target = current;
            SystemClock.sleep(120);
        }
        return target;
    }

    /** Set the field and read it back; retry before reporting what the field actually shows. */
    private String type(UiObject2 field, String text) {
        for (int attempt = 0; attempt < 3; attempt++) {
            field.click();
            field.setText(text);
            device.waitForIdle();
            if (isPassword(field) || text.equals(field.getText())) return null;
        }
        return "field shows \"" + field.getText() + "\" instead of \"" + text + "\" after typing";
    }

    /**
     * The accessibility tree lags the screen: Compose publishes semantics changes after a short debounce and
     * UiAutomation caches nodes. Drop the cache and read until two consecutive snapshots agree (at most 3 s).
     */
    private JSONObject stableTree(UiAutomation automation) throws Exception {
        String previous = null;
        JSONObject tree = null;
        long deadline = SystemClock.uptimeMillis() + 3000;
        do {
            if (previous != null) SystemClock.sleep(250);
            if (android.os.Build.VERSION.SDK_INT >= 34) automation.clearCache();
            tree = serialize(automation.getRootInActiveWindow());
            String current = tree.toString();
            if (current.equals(previous)) return tree;
            previous = current;
        } while (SystemClock.uptimeMillis() < deadline);
        return tree;
    }

    /** UiObject2 does not expose the password flag: read it from the editable node with the same bounds. */
    private boolean isPassword(UiObject2 field) {
        Rect bounds = field.getVisibleBounds();
        return findPassword(instrumentation.getUiAutomation().getRootInActiveWindow(), bounds);
    }

    private boolean findPassword(AccessibilityNodeInfo node, Rect bounds) {
        if (node == null) return false;
        Rect own = new Rect();
        node.getBoundsInScreen(own);
        if (node.isEditable() && own.equals(bounds)) return node.isPassword();
        for (int index = 0; index < node.getChildCount(); index++) if (findPassword(node.getChild(index), bounds)) return true;
        return false;
    }

    /** An IME window that stays on screen: the keyboard hides asynchronously after focus loss (Flutter takes a few frames). */
    private boolean keyboardVisible(UiAutomation automation) {
        long deadline = SystemClock.uptimeMillis() + 3000;
        while (imeOnScreen(automation)) {
            if (SystemClock.uptimeMillis() >= deadline) return true;
            SystemClock.sleep(100);
        }
        return false;
    }

    private boolean imeOnScreen(UiAutomation automation) {
        return imeBounds(automation) != null;
    }

    /** Screen bounds (px) of the input method window, or null when no keyboard is on screen. */
    private Rect imeBounds(UiAutomation automation) {
        if (android.os.Build.VERSION.SDK_INT >= 34) automation.clearCache();
        Rect bounds = new Rect();
        for (AccessibilityWindowInfo window : automation.getWindows()) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
            window.getBoundsInScreen(bounds);
            if (!bounds.isEmpty()) return bounds;
        }
        return null;
    }

    private boolean screenshot(UiAutomation automation, File file) throws Exception {
        Bitmap bitmap = automation.takeScreenshot();
        if (bitmap == null) return false;
        try (FileOutputStream stream = new FileOutputStream(file)) { return bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream); }
    }

    /** A failed capture still keeps what the screen showed: the screenshot and tree are evidence, never compared. */
    private JSONObject failure(JSONObject result, File out, String reason) throws Exception {
        UiAutomation automation = instrumentation.getUiAutomation();
        screenshot(automation, new File(out, "failure.png"));
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        if (root != null) result.put("tree", serialize(root));
        return result.put("status", "FAIL").put("reason", reason);
    }

    private JSONObject serialize(AccessibilityNodeInfo node) throws Exception {
        JSONObject item = new JSONObject();
        if (node == null) return item;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        item.put("className", String.valueOf(node.getClassName()));
        if (node.getViewIdResourceName() != null) item.put("resourceId", node.getViewIdResourceName());
        if (node.getText() != null) item.put("text", node.getText().toString());
        if (node.getContentDescription() != null) item.put("contentDescription", node.getContentDescription().toString());
        if (node.getHintText() != null) item.put("hint", node.getHintText().toString());
        item.put("showingHint", node.isShowingHintText());
        item.put("checkable", node.isCheckable()).put("checked", node.isChecked()).put("clickable", node.isClickable());
        item.put("editable", node.isEditable()).put("password", node.isPassword()).put("enabled", node.isEnabled()).put("visible", node.isVisibleToUser());
        item.put("bounds", new JSONObject().put("left", bounds.left).put("top", bounds.top).put("right", bounds.right).put("bottom", bounds.bottom));
        Rect local = new Rect();
        node.getBoundsInParent(local);
        item.put("size", new JSONObject().put("width", local.width()).put("height", local.height()));
        item.put("scrollable", node.isScrollable());
        JSONArray children = new JSONArray();
        for (int index = 0; index < node.getChildCount(); index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child != null) children.put(serialize(child));
        }
        if (children.length() > 0) item.put("children", children);
        return item;
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }
}
