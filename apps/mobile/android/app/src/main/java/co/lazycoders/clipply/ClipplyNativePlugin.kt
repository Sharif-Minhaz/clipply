package co.lazycoders.clipply

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
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
import android.graphics.BitmapFactory
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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
            Clip.None, Clip.TooLarge, Clip.Stored, is Clip.FileData -> out.put("type", "none")
            Clip.Sensitive -> out.put("type", "sensitive")
            is Clip.Text -> out.put("type", "text").put("text", clip.text).put("timestamp", clipTimestamp())
            is Clip.Image -> out.put("type", "image").put("mime", clip.mime).put("data", Base64.encodeToString(clip.bytes, Base64.NO_WRAP)).put("timestamp", clipTimestamp())
        }
        call.resolve(out)
    }

    /** When the current clip was set (API 26+), so the app can tell an unchanged clipboard from a new copy. */
    private fun clipTimestamp(): Long =
        if (Build.VERSION.SDK_INT >= 26) context.getSystemService(ClipboardManager::class.java).primaryClipDescription?.timestamp ?: 0 else 0

    @PluginMethod
    fun writeClipboardText(call: PluginCall) = guard(call) {
        val text = call.getString("text")!!
        val html = call.getString("html")
        val clip = if (html == null) ClipData.newPlainText("Clipply", text) else ClipData.newHtmlText("Clipply", text, html)
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
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
        for (file in Inbox.files(context)) {
            // Skips what the upload worker is sending; it reports back when it is done.
            if (!Inbox.claim(file)) continue
            try {
                val e = Inbox.read(context, file) ?: continue
                arr.put(JSObject.fromJSONObject(e))
                // Large entries stay until the app has read their parts (inboxDone).
                if (!e.has("parts")) Inbox.delete(context, file)
            } finally {
                Inbox.release(file)
            }
        }
        call.resolve(JSObject().put("entries", arr))
    }

    @PluginMethod
    fun inboxPart(call: PluginCall) = guard(call) {
        val data = Inbox.part(context, call.getString("id")!!, call.getInt("index")!!)
        call.resolve(JSObject().put("data", data?.let { Base64.encodeToString(it, Base64.NO_WRAP) } ?: JSONObject.NULL))
    }

    @PluginMethod
    fun inboxDone(call: PluginCall) = guard(call) {
        Inbox.done(context, call.getString("id")!!)
        call.resolve()
    }

    // ── chunks of large files ───────────────────────────────────────────────────────────────

    @PluginMethod
    fun chunkPut(call: PluginCall) = guard(call) {
        ChunkFiles.put(context, call.getString("id")!!, call.getInt("index")!!, Base64.decode(call.getString("data")!!, Base64.NO_WRAP))
        call.resolve()
    }

    @PluginMethod
    fun chunkGet(call: PluginCall) = guard(call) {
        val data = ChunkFiles.get(context, call.getString("id")!!, call.getInt("index")!!)
        call.resolve(JSObject().put("data", data?.let { Base64.encodeToString(it, Base64.NO_WRAP) } ?: JSONObject.NULL))
    }

    @PluginMethod
    fun chunkHas(call: PluginCall) = guard(call) {
        call.resolve(JSObject().put("has", ChunkFiles.has(context, call.getString("id")!!, call.getInt("index")!!)))
    }

    @PluginMethod
    fun chunkRemove(call: PluginCall) = guard(call) {
        ChunkFiles.remove(context, call.getString("id")!!)
        call.resolve()
    }

    @PluginMethod
    fun chunkIds(call: PluginCall) = guard(call) {
        call.resolve(JSObject().put("ids", JSArray(ChunkFiles.ids(context))))
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
        val data = Base64.decode(call.getString("data")!!, Base64.NO_WRAP)
        call.resolve(JSObject().put("json", Http.upload(call.getString("url")!!, call.getObject("fields")!!, data)))
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

    /**
     * Device pairing QR. Google's code scanner runs in Play services' own screen, so Clipply needs no
     * camera permission and never sees camera frames; only the decoded text comes back.
     */
    /** On-device OCR (ML Kit via Play services; the model arrives with the app, see the manifest). Latin script; ML Kit has no Bengali, see ocr.ts. */
    @PluginMethod
    fun recognizeText(call: PluginCall) = guard(call) {
        val bytes = Base64.decode(call.getString("data") ?: return@guard call.reject("data is required"), Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@guard call.reject("image could not be decoded")
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { call.resolve(JSObject().put("text", it.text)) }
            .addOnFailureListener { call.reject(it.message ?: "text recognition unavailable", it) }
    }

    @PluginMethod
    fun scanQr(call: PluginCall) {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(activity, options).startScan()
            .addOnSuccessListener { call.resolve(JSObject().put("text", it.rawValue ?: JSONObject.NULL)) }
            .addOnCanceledListener { call.resolve(JSObject().put("text", JSONObject.NULL)) }
            .addOnFailureListener { call.reject(it.message ?: "QR scanner unavailable", it) }
    }

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

    /** Documents being written piece by piece; kept open, because not every provider can append to a file. */
    private val documents = java.util.concurrent.ConcurrentHashMap<String, java.io.OutputStream>()

    /** Like saveDocument, for large files: appendDocument adds each piece, closeDocument finishes. */
    @PluginMethod
    fun createDocument(call: PluginCall) {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, call.getString("name") ?: "file")
        startActivityForResult(call, intent, "createdDocument")
    }

    @ActivityCallback
    private fun createdDocument(call: PluginCall, result: ActivityResult) = guard(call) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) return@guard call.resolve(JSObject().put("handle", JSONObject.NULL))
        val handle = java.util.UUID.randomUUID().toString()
        documents[handle] = context.contentResolver.openOutputStream(uri, "wt")!!
        call.resolve(JSObject().put("handle", handle))
    }

    @PluginMethod
    fun appendDocument(call: PluginCall) = guard(call) {
        documents.getValue(call.getString("handle")!!).write(Base64.decode(call.getString("data")!!, Base64.NO_WRAP))
        call.resolve()
    }

    @PluginMethod
    fun closeDocument(call: PluginCall) = guard(call) {
        documents.remove(call.getString("handle")!!)?.close()
        call.resolve()
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

    // ── app update: the APK of a GitHub release, handed to the system installer ─────────────

    /**
     * Downloads Clipply-<version>.apk from this project's release and opens the system installer
     * (one tap to confirm). Android itself refuses it unless it is signed with the installed app's key.
     */
    @PluginMethod
    fun installUpdate(call: PluginCall) = guard(call) {
        val version = call.getString("version")!!
        require(Regex("[0-9]{1,6}[.][0-9]{1,6}[.][0-9]{1,6}").matches(version)) { "not a release version: $version" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
            return@guard call.reject("Allow Clipply to install apps, then tap Update again.")
        }
        val apk = File(context.cacheDir, "update.apk")
        val c = URL("https://github.com/Sharif-Minhaz/clipply/releases/download/v$version/Clipply-$version.apk").openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 120_000
        if (c.responseCode !in 200..299) throw java.io.IOException("download failed (${c.responseCode})")
        val total = c.contentLengthLong
        var done = 0L
        var reported = -1
        c.inputStream.use { input ->
            apk.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    val percent = if (total > 0) (done * 100 / total).toInt() else -1
                    if (percent > reported) {
                        reported = percent
                        notifyListeners("updateProgress", JSObject().put("percent", percent))
                    }
                }
            }
        }
        val info = context.packageManager.getPackageArchiveInfo(apk.path, 0)
        if (info?.packageName != context.packageName || info.versionName != version) {
            apk.delete()
            throw java.io.IOException("the download is not Clipply $version")
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        activity.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
        )
        call.resolve()
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
