package co.lazycoders.clipply

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import androidx.activity.result.ActivityResult
import android.os.Build
import android.provider.Settings
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

@CapacitorPlugin(
    name = "ClipplyNative",
    permissions = [
        Permission(alias = "photos", strings = [Manifest.permission.READ_MEDIA_IMAGES]),
        Permission(alias = "storage", strings = [Manifest.permission.READ_EXTERNAL_STORAGE]),
    ],
)
class ClipplyNativePlugin : Plugin() {
    companion object {
        @Volatile var instance: ClipplyNativePlugin? = null
    }

    override fun load() {
        instance = this
        Inbox.onAdded = { notifyListeners("inbox", JSObject()) }
    }

    fun windowFocused() = notifyListeners("windowFocus", JSObject())

    // ── secure storage ──────────────────────────────────────────────────────────────────────

    @PluginMethod
    fun secureGet(call: PluginCall) = guard(call) {
        call.resolve(JSObject().put("value", SecureStore.get(context, call.getString("key")!!)))
    }

    @PluginMethod
    fun secureSet(call: PluginCall) = guard(call) {
        SecureStore.put(context, call.getString("key")!!, call.getString("value")!!)
        call.resolve()
    }

    @PluginMethod
    fun secureRemove(call: PluginCall) = guard(call) {
        SecureStore.remove(context, call.getString("key")!!)
        call.resolve()
    }

    // ── clipboard ───────────────────────────────────────────────────────────────────────────

    @PluginMethod
    fun readClipboard(call: PluginCall) = guard(call) {
        val out = JSObject()
        when (val clip = readClip(context)) {
            Clip.None, Clip.TooLarge, is Clip.FileData -> out.put("type", "none")
            Clip.Sensitive -> out.put("type", "sensitive")
            is Clip.Text -> out.put("type", "text").put("text", clip.text)
            is Clip.Image -> out.put("type", "image").put("mime", clip.mime).put("data", Base64.encodeToString(clip.bytes, Base64.NO_WRAP))
        }
        call.resolve(out)
    }

    @PluginMethod
    fun writeClipboardText(call: PluginCall) = guard(call) {
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Clipply", call.getString("text")!!))
        call.resolve()
    }

    @PluginMethod
    fun writeClipboardImage(call: PluginCall) = guard(call) {
        ClipImageProvider.set(Base64.decode(call.getString("data")!!, Base64.NO_WRAP), call.getString("mime")!!)
        val clip = ClipData.newUri(context.contentResolver, "Clipply image", ClipImageProvider.uri(context))
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
        call.resolve()
    }

    // ── inbox, background work ──────────────────────────────────────────────────────────────

    @PluginMethod
    fun drainInbox(call: PluginCall) = guard(call) {
        val arr = JSArray()
        for ((file, e) in Inbox.list(context)) {
            arr.put(JSObject.fromJSONObject(e))
            file.delete()
        }
        call.resolve(JSObject().put("entries", arr))
    }

    @PluginMethod
    fun scheduleUpload(call: PluginCall) = guard(call) {
        UploadWorker.enqueue(context)
        call.resolve()
    }

    @PluginMethod
    fun setBackgroundUpload(call: PluginCall) = guard(call) {
        UploadWorker.setEnabled(context, call.getBoolean("enabled") ?: true)
        call.resolve()
    }

    private val photoAlias get() = if (Build.VERSION.SDK_INT >= 33) "photos" else "storage"

    @PluginMethod
    fun setScreenshotWatch(call: PluginCall) {
        if (call.getBoolean("enabled") != true) {
            ScreenshotWorker.setEnabled(context, false)
            call.resolve(JSObject().put("granted", true))
            return
        }
        if (getPermissionState(photoAlias) == PermissionState.GRANTED) {
            ScreenshotWorker.setEnabled(context, true)
            call.resolve(JSObject().put("granted", true))
        } else {
            requestPermissionForAlias(photoAlias, call, "photosResult")
        }
    }

    @PermissionCallback
    private fun photosResult(call: PluginCall) {
        val granted = getPermissionState(photoAlias) == PermissionState.GRANTED
        ScreenshotWorker.setEnabled(context, granted)
        call.resolve(JSObject().put("granted", granted))
    }

    // ── blob transport (Cloudinary; native to avoid WebView CORS limits) ─────────────────────

    @PluginMethod
    fun uploadBlob(call: PluginCall) = guard(call) {
        val boundary = "clipply-${UUID.randomUUID()}"
        val body = ByteArrayOutputStream()
        val fields = call.getObject("fields")!!
        for (k in fields.keys()) {
            body.write("--$boundary\r\nContent-Disposition: form-data; name=\"$k\"\r\n\r\n${fields.getString(k)}\r\n".toByteArray())
        }
        body.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"blob.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n".toByteArray())
        body.write(Base64.decode(call.getString("data")!!, Base64.NO_WRAP))
        body.write("\r\n--$boundary--\r\n".toByteArray())
        val c = URL(call.getString("url")!!).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.connectTimeout = 15_000
        c.readTimeout = 120_000
        c.setRequestProperty("content-type", "multipart/form-data; boundary=$boundary")
        c.outputStream.use { it.write(body.toByteArray()) }
        if (c.responseCode !in 200..299) throw java.io.IOException("blob upload failed (${c.responseCode})")
        call.resolve(JSObject().put("json", c.inputStream.bufferedReader().use { it.readText() }))
    }

    @PluginMethod
    fun downloadBlob(call: PluginCall) = guard(call) {
        val c = URL(call.getString("url")!!).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 120_000
        if (c.responseCode !in 200..299) throw java.io.IOException("blob download failed (${c.responseCode})")
        call.resolve(JSObject().put("data", Base64.encodeToString(c.inputStream.use { it.readBytes() }, Base64.NO_WRAP)))
    }

    // ── backup files (Storage Access Framework: the user picks the location, no storage permission) ──

    @PluginMethod
    fun saveDocument(call: PluginCall) {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, call.getString("name") ?: "clipply.clipply")
        startActivityForResult(call, intent, "savedDocument")
    }

    @ActivityCallback
    private fun savedDocument(call: PluginCall, result: ActivityResult) = guard(call) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) return@guard call.resolve(JSObject().put("saved", false))
        context.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(Base64.decode(call.getString("data")!!, Base64.NO_WRAP)) }
        call.resolve(JSObject().put("saved", true))
    }

    @PluginMethod
    fun openDocument(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        startActivityForResult(call, intent, "openedDocument")
    }

    @ActivityCallback
    private fun openedDocument(call: PluginCall, result: ActivityResult) = guard(call) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) return@guard call.resolve(JSObject().put("data", null))
        val bytes = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
        call.resolve(JSObject().put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
    }

    @PluginMethod
    fun deviceName(call: PluginCall) {
        val name = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        call.resolve(JSObject().put("name", name))
    }

    /** Plugin calls run off the UI thread; failures reach JS as rejected promises, never crashes. */
    private inline fun guard(call: PluginCall, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            call.reject(e.message ?: e.javaClass.simpleName, e)
        }
    }
}
