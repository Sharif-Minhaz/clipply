package co.lazycoders.clipply

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Items captured while the WebView may not be running (share sheet, text selection, Quick Settings
 * tile, screenshots). Each entry is Keystore-encrypted on disk — never plaintext — and is removed
 * once the app imports it or the upload worker has pushed it.
 */
object Inbox {
    const val MAX_BYTES = 10 * 1024 * 1024
    /** Same limit as MAX_FILE_BYTES in packages/shared-schemas. */
    const val MAX_LARGE_BYTES = 100L * 1024 * 1024
    private const val PART_BYTES = 4 * 1024 * 1024
    private const val STALE_PART_MS = 3_600_000L
    @Volatile var onAdded: (() -> Unit)? = null

    /** Entries being imported or uploaded right now, so the app and the upload worker never take the same one. */
    private val busy = ConcurrentHashMap.newKeySet<String>()

    private fun dir(ctx: Context) = File(ctx.noBackupFilesDir, "inbox").apply { mkdirs() }

    /** Returns false when the payload is empty or larger than one encrypted blob may be. */
    /** `createdAt`: when the content was made (a screenshot's MediaStore time), defaulting to now. */
    fun add(ctx: Context, type: String, mime: String, data: ByteArray, source: String, name: String? = null, createdAt: Long? = null): Boolean {
        if (data.isEmpty() || data.size > MAX_BYTES) return false
        val now = createdAt ?: System.currentTimeMillis()
        val id = UUID.randomUUID().toString()
        val json = entry(id, now, type, mime, source, name).put("data", Base64.encodeToString(data, Base64.NO_WRAP))
        store(ctx, "$now-$id", json)
        return true
    }

    /**
     * A large file as separately encrypted parts, so it is never in memory whole. `head` is what was already
     * read. Returns false (and keeps nothing) when it is over MAX_LARGE_BYTES.
     */
    fun addLarge(ctx: Context, type: String, mime: String, head: ByteArray, rest: InputStream, source: String, name: String?): Boolean {
        val now = System.currentTimeMillis()
        val id = UUID.randomUUID().toString()
        val base = "$now-$id"
        var parts = 0
        var total = 0L
        val input = java.io.SequenceInputStream(head.inputStream(), rest)
        try {
            while (true) {
                val part = readUpTo(input, PART_BYTES)
                if (part.isEmpty()) break
                total += part.size
                if (total > MAX_LARGE_BYTES) throw java.io.IOException("too large")
                File(dir(ctx), "$base.part$parts").writeBytes(SecureStore.encrypt(part))
                parts++
            }
        } catch (e: Exception) {
            deleteParts(ctx, base)
            return false
        }
        store(ctx, base, entry(id, now, type, mime, source, name).put("parts", parts))
        return true
    }

    fun addText(ctx: Context, text: String, source: String): Boolean =
        text.isNotBlank() && add(ctx, "text", "text/plain", text.toByteArray(Charsets.UTF_8), source)

    private fun entry(id: String, now: Long, type: String, mime: String, source: String, name: String?): JSONObject {
        val json = JSONObject().put("id", id).put("createdAt", now).put("type", type).put("mime", mime).put("source", source)
        if (name != null) json.put("name", name)
        return json
    }

    private fun store(ctx: Context, base: String, json: JSONObject) {
        val f = File(dir(ctx), "$base.bin")
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeBytes(SecureStore.encrypt(json.toString().toByteArray(Charsets.UTF_8)))
        tmp.renameTo(f)
        onAdded?.invoke()
    }

    /** At most `max` bytes; fewer only at the end of the stream. */
    fun readUpTo(input: InputStream, max: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (out.size() < max) {
            val n = input.read(buf, 0, minOf(buf.size, max - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    /** Oldest first. */
    fun files(ctx: Context): List<File> {
        val all = dir(ctx).listFiles() ?: emptyArray()
        // Parts whose entry was never written (the app died while saving a large file).
        for (p in all) {
            if (!p.name.contains(".part") || System.currentTimeMillis() - p.lastModified() < STALE_PART_MS) continue
            if (!File(p.parentFile, "${p.name.substringBefore(".part")}.bin").exists()) p.delete()
        }
        return all.filter { it.name.endsWith(".bin") }.sortedBy { it.name }
    }

    /** null when unreadable (e.g. Keystore key lost): such an entry is dropped rather than retried forever. */
    fun read(ctx: Context, file: File): JSONObject? =
        try {
            JSONObject(String(SecureStore.decrypt(file.readBytes()), Charsets.UTF_8))
        } catch (e: java.io.FileNotFoundException) {
            null
        } catch (e: OutOfMemoryError) {
            null
        } catch (e: Exception) {
            delete(ctx, file)
            null
        }

    /** True when the caller may take this entry; pair with `release`. */
    fun claim(file: File): Boolean = busy.add(file.name) && (file.exists() || !busy.remove(file.name))

    fun release(file: File) {
        busy.remove(file.name)
    }

    fun delete(ctx: Context, file: File) {
        file.delete()
        deleteParts(ctx, file.name.removeSuffix(".bin"))
    }

    private fun deleteParts(ctx: Context, base: String) {
        dir(ctx).listFiles { f -> f.name.startsWith("$base.part") }?.forEach { it.delete() }
    }

    private fun fileOf(ctx: Context, id: String): File? = files(ctx).firstOrNull { it.name.endsWith("-$id.bin") }

    fun part(ctx: Context, id: String, index: Int): ByteArray? =
        fileOf(ctx, id)?.let { File(it.parentFile, "${it.name.removeSuffix(".bin")}.part$index") }?.takeIf { it.exists() }?.let { SecureStore.decrypt(it.readBytes()) }

    /** The app has imported a large entry. */
    fun done(ctx: Context, id: String) {
        fileOf(ctx, id)?.let { delete(ctx, it) }
    }
}
