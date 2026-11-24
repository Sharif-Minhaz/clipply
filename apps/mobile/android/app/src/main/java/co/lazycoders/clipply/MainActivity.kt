package co.lazycoders.clipply

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    companion object {
        /** The app is on screen and imports captures itself. */
        @Volatile var visible = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ClipplyNativePlugin::class.java)
        super.onCreate(savedInstanceState)
    }

    override fun onStart() {
        super.onStart()
        visible = true
    }

    override fun onStop() {
        visible = false
        super.onStop()
        // Anything that arrived while the app was open but was not imported.
        if (Inbox.files(applicationContext).isNotEmpty()) UploadWorker.enqueue(applicationContext)
    }

    /** The only moment Android lets us read the clipboard: our window just gained focus. */
    override fun onResume() {
        super.onResume()
        ScreenshotWorker.catchUp(applicationContext)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) ClipplyNativePlugin.instance?.windowFocused()
    }
}
