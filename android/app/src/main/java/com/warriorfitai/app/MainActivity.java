package com.warriorfitai.app;

import android.webkit.PermissionRequest;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

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
