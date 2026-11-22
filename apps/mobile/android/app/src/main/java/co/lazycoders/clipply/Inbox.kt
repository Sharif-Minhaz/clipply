package co.lazycoders.clipply

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Items captured while the WebView may not be running (share sheet, text selection, Quick Settings
 * tile, screenshots). Each entry is Keystore-encrypted on disk — never plaintext — and is removed
 * once the app imports it or the upload worker has pushed it.
 */
object Inbox {
    const val MAX_BYTES = 10 * 1024 * 1024
    @Volatile var onAdded: (() -> Unit)? = null

    private fun dir(ctx: Context) = File(ctx.noBackupFilesDir, "inbox").apply { mkdirs() }

    /** Returns false when the payload is empty or larger than one encrypted blob may be. */
    fun add(ctx: Context, type: String, mime: String, data: ByteArray, source: String, name: String? = null): Boolean {
        if (data.isEmpty() || data.size > MAX_BYTES) return false
        val now = System.currentTimeMillis()
        val id = UUID.randomUUID().toString()
        val json = JSONObject()
            .put("id", id).put("createdAt", now).put("type", type).put("mime", mime).put("source", source)
            .put("data", Base64.encodeToString(data, Base64.NO_WRAP))
        if (name != null) json.put("name", name)
        val f = File(dir(ctx), "$now-$id.bin")
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeBytes(SecureStore.encrypt(json.toString().toByteArray(Charsets.UTF_8)))
        tmp.renameTo(f)
        onAdded?.invoke()
        return true
    }

    fun addText(ctx: Context, text: String, source: String): Boolean =
        text.isNotBlank() && add(ctx, "text", "text/plain", text.toByteArray(Charsets.UTF_8), source)

    /** Oldest first. Unreadable entries (e.g. Keystore key lost) are dropped rather than retried forever. */
    fun list(ctx: Context): List<Pair<File, JSONObject>> =
        (dir(ctx).listFiles { f -> f.name.endsWith(".bin") } ?: emptyArray()).sortedBy { it.name }.mapNotNull { f ->
            try {
                f to JSONObject(String(SecureStore.decrypt(f.readBytes()), Charsets.UTF_8))
            } catch (e: Exception) {
                f.delete()
                null
            }
        }
}
