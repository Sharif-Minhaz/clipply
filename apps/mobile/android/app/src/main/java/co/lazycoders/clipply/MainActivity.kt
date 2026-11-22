package co.lazycoders.clipply

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ClipplyNativePlugin::class.java)
        super.onCreate(savedInstanceState)
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
