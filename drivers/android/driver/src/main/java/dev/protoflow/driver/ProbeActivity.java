package dev.protoflow.driver;

import android.app.Activity;
import android.graphics.Insets;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;

/**
 * Measures the device content area: the screen minus system bars and display cutout. The activity has no action bar
 * and draws edge to edge, so the root window insets are exactly what an edge-to-edge app must keep clear.
 */
public class ProbeActivity extends Activity {
    static volatile Insets insets;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setDecorFitsSystemWindows(false);
        View view = new View(this);
        setContentView(view);
        view.post(() -> {
            WindowInsets root = getWindow().getDecorView().getRootWindowInsets();
            if (root != null) insets = root.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        });
    }
}
