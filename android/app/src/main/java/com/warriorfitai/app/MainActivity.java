package com.warriorfitai.app;

import android.os.Bundle;
import android.webkit.PermissionRequest;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.tchvu3.capacitorvoicerecorder.VoiceRecorder;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Explicitly register the native voice recorder plugin. Capacitor normally
        // auto-registers plugins from the generated capacitor.plugins.json in assets,
        // but that file is gitignored (android/.gitignore) and is only produced by
        // `npx cap sync`. On a build machine that compiles the AAB from a fresh checkout
        // without running sync, the file is absent, the plugin class is compiled in but
        // never registered, and the web layer sees "VoiceRecorder plugin is not
        // implemented on android". Registering here guarantees availability regardless
        // of whether the generated asset is present. Must run before super.onCreate().
        registerPlugin(VoiceRecorder.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onStart() {
        super.onStart();

        // In remote server.url mode the web layer's getUserMedia() (camera capture,
        // microphone) triggers a WebView PermissionRequest. Capacitor's default
        // client does not automatically bridge the OS-granted permissions, so the
        // camera falls back to the gallery and the mic is denied. Extend the
        // BridgeWebChromeClient (to keep Capacitor's file chooser / JS dialogs) and
        // grant exactly the resources the page asks for. The OS-level CAMERA and
        // RECORD_AUDIO permissions must still be granted in Android Settings — this
        // only forwards them into the WebView.
        this.bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(this.bridge) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }
}
