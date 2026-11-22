package co.lazycoders.clipply

import android.app.Activity
import android.app.PendingIntent
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.service.quicksettings.TileService
import android.widget.Toast
import kotlin.concurrent.thread

/** What the clipboard holds right now. Only valid while one of our windows has input focus. */
sealed class Clip {
    data object None : Clip()
    data object Sensitive : Clip()
    data object TooLarge : Clip()
    data class Text(val text: String) : Clip()
    data class Image(val bytes: ByteArray, val mime: String) : Clip()
    data class FileData(val bytes: ByteArray, val mime: String, val name: String) : Clip()
}

fun readClip(ctx: Context): Clip {
    val cm = ctx.getSystemService(ClipboardManager::class.java)
    val clip = cm.primaryClip ?: return Clip.None
    if (clip.itemCount == 0) return Clip.None
    val desc = clip.description
    // Android 13+: password managers flag secrets; Clipply never stores them.
    if (desc.extras?.getBoolean("android.content.extra.IS_SENSITIVE") == true) return Clip.Sensitive
    val item = clip.getItemAt(0)
    val mime = (0 until desc.mimeTypeCount).map { desc.getMimeType(it) }.firstOrNull { it.startsWith("image/") }
    if (mime != null && item.uri != null) {
        val bytes = runCatching { ctx.contentResolver.openInputStream(item.uri)?.use { it.readBytes() } }.getOrNull()
        if (bytes != null && bytes.size <= Inbox.MAX_BYTES) return Clip.Image(bytes, mime)
    }
    val text = item.coerceToText(ctx)?.toString()
    return if (text.isNullOrBlank()) Clip.None else Clip.Text(text)
}

fun saveClip(ctx: Context, clip: Clip, source: String): String = when (clip) {
    is Clip.Text -> if (Inbox.addText(ctx, clip.text, source)) "Saved to Clipply" else "Nothing to save"
    is Clip.Image -> if (Inbox.add(ctx, "image", clip.mime, clip.bytes, source)) "Image saved to Clipply" else "Image too large"
    is Clip.FileData -> if (Inbox.add(ctx, "file", clip.mime, clip.bytes, source, clip.name)) "File saved to Clipply" else "File too large (10 MB max)"
    Clip.Sensitive -> "Sensitive content is not saved"
    Clip.TooLarge -> "Too large to save (10 MB max)"
    Clip.None -> "Clipboard is empty"
}.also { UploadWorker.enqueue(ctx) }

/**
 * Invisible activity started from the Quick Settings tile or notification action. Android lets an
 * app read the clipboard only while it has focus, so the read happens in onWindowFocusChanged.
 */
class CaptureActivity : Activity() {
    private var done = false

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || done) return
        done = true
        val msg = saveClip(this, readClip(this), "tile")
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        finish()
    }
}

/** Share sheet (text, images) and the text-selection "Save to Clipply" action. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val i = intent
        val ctx = applicationContext
        thread {
            val msg = when (i.action) {
                Intent.ACTION_PROCESS_TEXT -> saveClip(ctx, i.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.let { Clip.Text(it) } ?: Clip.None, "process_text")
                Intent.ACTION_SEND -> shareOne(ctx, i)
                Intent.ACTION_SEND_MULTIPLE -> {
                    val uris = if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else @Suppress("DEPRECATION") i.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                    val saved = uris.orEmpty().count { stream(ctx, it, i.type)?.let { c -> saveClip(ctx, c, "share"); true } ?: false }
                    "$saved items saved to Clipply"
                }
                else -> "Nothing to save"
            }
            runOnUiThread {
                Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
                finish()
            }
        }
    }

    private fun shareOne(ctx: Context, i: Intent): String {
        i.getCharSequenceExtra(Intent.EXTRA_TEXT)?.let { return saveClip(ctx, Clip.Text(it.toString()), "share") }
        val uri = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else @Suppress("DEPRECATION") i.getParcelableExtra(Intent.EXTRA_STREAM)
        return saveClip(ctx, uri?.let { stream(ctx, it, i.type) } ?: Clip.None, "share")
    }

    /** A shared image or any other file. Oversize content is not read into memory. */
    private fun stream(ctx: Context, uri: Uri, type: String?): Clip? {
        val mime = ctx.contentResolver.getType(uri) ?: type ?: "application/octet-stream"
        var name = "file"
        var size = -1L
        runCatching {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        }
        if (size > Inbox.MAX_BYTES) return Clip.TooLarge
        val bytes = runCatching { ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() ?: return null
        return if (mime.startsWith("image/")) Clip.Image(bytes, mime) else Clip.FileData(bytes, mime, name)
    }
}

/** Quick Settings tile: one tap saves the current clipboard. No background work at all. */
class ClipboardTileService : TileService() {
    override fun onClick() {
        super.onClick()
        val intent = Intent(this, CaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}

/**
 * Serves an image copied from history to other apps straight from memory, so no plaintext image
 * file is ever written (the clipboard needs a content URI for images).
 */
class ClipImageProvider : ContentProvider() {
    companion object {
        @Volatile private var current: Pair<ByteArray, String>? = null
        fun uri(ctx: Context): Uri = Uri.parse("content://${ctx.packageName}.clipimage/current")
        fun set(bytes: ByteArray, mime: String) {
            current = bytes to mime
        }
    }

    override fun onCreate() = true
    override fun getType(uri: Uri): String? = current?.second
    override fun getStreamTypes(uri: Uri, mimeTypeFilter: String): Array<String>? =
        current?.second?.let { m -> if (ClipDescription.compareMimeTypes(m, mimeTypeFilter)) arrayOf(m) else null }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val (bytes) = current ?: throw java.io.FileNotFoundException("no image")
        val (read, write) = ParcelFileDescriptor.createPipe()
        thread { ParcelFileDescriptor.AutoCloseOutputStream(write).use { it.write(bytes) } }
        return read
    }

    override fun query(uri: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?) = null
    override fun insert(uri: Uri, values: ContentValues?) = null
    override fun delete(uri: Uri, s: String?, a: Array<String>?) = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<String>?) = 0
}
