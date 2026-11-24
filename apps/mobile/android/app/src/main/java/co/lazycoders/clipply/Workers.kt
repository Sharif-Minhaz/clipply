package co.lazycoders.clipply

import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.TimeUnit

private const val TAG = "Clipply"

/** Minimal JSON-over-HTTPS client for the worker (the WebView uses @clipply/api-client). */
object Http {
    class Status(val code: Int, val body: String) : IOException("HTTP $code")

    fun json(method: String, url: String, body: JSONObject?, bearer: String?): JSONObject {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.setRequestProperty("accept", "application/json")
        bearer?.let { c.setRequestProperty("authorization", "Bearer $it") }
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        }
        val code = c.responseCode
        val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) throw Status(code, text)
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    /** Multipart POST of ciphertext to Cloudinary with the server-signed fields; returns its JSON response. */
    fun upload(url: String, fields: JSONObject, data: ByteArray): String {
        val boundary = "clipply-${UUID.randomUUID()}"
        val head = StringBuilder()
        for (k in fields.keys()) head.append("--$boundary\r\nContent-Disposition: form-data; name=\"$k\"\r\n\r\n${fields.getString(k)}\r\n")
        head.append("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip\"\r\nContent-Type: application/octet-stream\r\n\r\n")
        val start = head.toString().toByteArray()
        val end = "\r\n--$boundary--\r\n".toByteArray()
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.connectTimeout = 15_000
        c.readTimeout = 120_000
        // Sent as it is written instead of being buffered a second time.
        c.setFixedLengthStreamingMode(start.size + data.size + end.size)
        c.setRequestProperty("content-type", "multipart/form-data; boundary=$boundary")
        c.outputStream.use {
            it.write(start)
            it.write(data)
            it.write(end)
        }
        if (c.responseCode !in 200..299) {
            // Cloudinary explains rejections in {"error":{"message":…}}; it never contains clip content.
            val body = c.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val reason = runCatching { JSONObject(body).getJSONObject("error").getString("message") }.getOrDefault(body.take(300))
            throw IOException("blob upload failed (${c.responseCode}): $reason")
        }
        return c.inputStream.bufferedReader().use { it.readText() }
    }
}

/**
 * Uploads what was captured while the app was closed: text in one batch, then images and files up to
 * 10 MB one by one (decoded, thumbnailed and encrypted here, then straight to Cloudinary). One unique job,
 * network-constrained, with exponential backoff; it never polls and exits when the inbox is empty. Larger
 * files, huge photos and anything the server does not accept wait for the app.
 */
class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    private lateinit var api: String
    private lateinit var token: String

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // Sync paused on this device: captures stay in the inbox until the app imports them.
        // On screen, the app imports them itself.
        if (!isEnabled(ctx) || MainActivity.visible) return Result.success()
        val config = SecureStore.get(ctx, "config")?.let(::JSONObject) ?: return Result.success()
        var session = SecureStore.get(ctx, "session")?.let(::JSONObject) ?: return Result.success()
        val vault = SecureStore.get(ctx, "vault")?.let(::JSONObject) ?: return Result.success()
        api = config.getString("apiUrl").trimEnd('/')
        if (Inbox.files(ctx).isEmpty()) return Result.success()

        return try {
            if (session.getLong("accessExpiresAt") - 60_000 < System.currentTimeMillis()) {
                val auth = Http.json("POST", "$api/v1/auth/refresh", JSONObject().put("refreshToken", session.getString("refreshToken")), null)
                session = JSONObject()
                    .put("userId", session.getString("userId")).put("email", session.getString("email"))
                    .put("refreshToken", auth.getString("refreshToken")).put("accessToken", auth.getString("accessToken"))
                    .put("accessExpiresAt", auth.getLong("accessExpiresAt"))
                SecureStore.put(ctx, "session", session.toString())
            }
            token = session.getString("accessToken")
            val crypto = ItemCrypto(String(ItemCrypto.b64urlDecode(vault.getString("keyring")), Charsets.UTF_8))
            val deviceId = vault.getString("deviceId")
            val (blobs, textsLeft) = uploadTexts(ctx, crypto, deviceId)
            var uploaded = 0
            for (file in blobs) {
                // The app came on screen meanwhile and imports the rest.
                if (isStopped || MainActivity.visible || uploaded >= MAX_BLOBS) break
                if (uploadBlob(ctx, crypto, deviceId, file)) uploaded++
            }
            // Only after progress: entries left for the app must not start runs forever.
            if ((uploaded >= MAX_BLOBS || textsLeft) && !MainActivity.visible) enqueue(ctx)
            Result.success()
        } catch (e: Http.Status) {
            Log.w(TAG, "upload failed: HTTP ${e.code}")
            // 401/403: the session or device is gone; the app will explain. Others: retry with backoff.
            if (e.code == 401 || e.code == 403 || e.code == 400) Result.success() else Result.retry()
        } catch (e: IOException) {
            Result.retry()
        } finally {
            // The app may have skipped entries this run was holding.
            if (MainActivity.visible) Inbox.onAdded?.invoke()
        }
    }

    /** Pushes waiting texts in one request; returns the other entries, and whether more texts are worth another run. Entries are read one at a time: images are large. */
    private fun uploadTexts(ctx: Context, crypto: ItemCrypto, deviceId: String): Pair<List<File>, Boolean> {
        val others = mutableListOf<File>()
        val ops = JSONArray()
        val claimed = mutableListOf<File>()
        val sent = mutableListOf<File>()
        var more = false
        var applied = 0
        try {
            for (file in Inbox.files(ctx)) {
                if (!Inbox.claim(file)) continue
                val e = Inbox.read(ctx, file)
                if (e == null || e.getString("type") != "text") {
                    Inbox.release(file)
                    if (e != null && e.has("data")) others += file
                    continue
                }
                claimed += file
                if (ops.length() >= MAX_TEXTS) {
                    more = true
                    continue
                }
                val text = String(decode(e), Charsets.UTF_8)
                ops.put(upsert(crypto.encryptText(text, deviceId, e.getLong("createdAt")) ?: continue))
                sent += file
            }
            if (ops.length() > 0) {
                val results = push(ops)
                // applied → the server has it and the app will pull it; anything else stays for the app to handle.
                for (i in 0 until results.length()) {
                    if (results.getJSONObject(i).getString("status") != "applied") continue
                    Inbox.delete(ctx, sent[i])
                    applied++
                }
            }
        } finally {
            claimed.forEach(Inbox::release)
        }
        return others to (more && applied > 0)
    }

    /** True when the server has it now. */
    private fun uploadBlob(ctx: Context, crypto: ItemCrypto, deviceId: String, file: File): Boolean {
        if (!Inbox.claim(file)) return false
        try {
            val e = Inbox.read(ctx, file) ?: return false
            val kind = e.getString("type")
            val data = decode(e)
            val mime = e.getString("mime")
            val createdAt = e.getLong("createdAt")
            val made = if (kind == "image") {
                val image = Images.decode(data) ?: return false
                crypto.encryptBlob("image", mime, data, image.rgba, image.thumb, null, deviceId, createdAt)
            } else {
                crypto.encryptBlob("file", mime, data, data, null, e.optString("name", "file"), deviceId, createdAt)
            } ?: return false
            val sig = Http.json("POST", "$api/v1/storage/upload-signature", JSONObject().put("itemId", made.id).put("size", made.body.size), token)
            val stored = JSONObject(Http.upload(sig.getString("uploadUrl"), sig.getJSONObject("fields"), made.body))
            val key = sig.getString("key")
            val receipt = JSONObject()
            for (k in listOf("public_id", "version", "signature", "bytes")) receipt.put(k, stored.get(k))
            Http.json("POST", "$api/v1/storage/confirm", JSONObject().put("key", key).put("upload", receipt), token)
            made.item.put("blob", JSONObject().put("key", key).put("size", made.body.size))
            if (push(JSONArray().put(upsert(made.item))).getJSONObject(0).getString("status") != "applied") return false
            Inbox.delete(ctx, file)
            return true
        } catch (e: OutOfMemoryError) {
            Log.w(TAG, "image left for the app: not enough memory")
        } catch (e: Http.Status) {
            // This entry is not acceptable as it is; the next one may be.
            if (e.code != 400 && e.code != 409) throw e
            Log.w(TAG, "entry left for the app: HTTP ${e.code}")
        } finally {
            Inbox.release(file)
        }
        return false
    }

    private fun decode(e: JSONObject): ByteArray = android.util.Base64.decode(e.getString("data"), android.util.Base64.NO_WRAP)

    private fun upsert(item: JSONObject) = JSONObject().put("type", "upsert").put("opId", UUID.randomUUID().toString()).put("baseRev", 0).put("item", item)

    private fun push(ops: JSONArray): JSONArray = Http.json("POST", "$api/v1/sync/push", JSONObject().put("ops", ops), token).getJSONArray("results")

    companion object {
        /** One push stays well under the server's 4 MB body limit. */
        private const val MAX_TEXTS = 40
        /** WorkManager stops a job after 10 minutes; the rest is queued as another run. */
        private const val MAX_BLOBS = 10

        private fun prefs(ctx: Context) = ctx.getSharedPreferences("clipply.sync", Context.MODE_PRIVATE)
        fun isEnabled(ctx: Context) = prefs(ctx).getBoolean("upload", true)

        fun setEnabled(ctx: Context, enabled: Boolean) {
            prefs(ctx).edit().putBoolean("upload", enabled).apply()
            if (!enabled) WorkManager.getInstance(ctx).cancelUniqueWork("clipply-upload")
        }

        fun enqueue(ctx: Context) {
            if (!isEnabled(ctx)) return
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork("clipply-upload", ExistingWorkPolicy.APPEND_OR_REPLACE, req)
        }
    }
}

/**
 * Imports new screenshots. Scheduled with a MediaStore content-URI trigger, so the OS wakes it
 * only when images change; it re-arms itself after each run. Only files under a "Screenshots"
 * folder newer than the last run are read; nothing is scanned.
 */
class ScreenshotWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val prefs = ctx.getSharedPreferences("clipply.screenshots", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("enabled", false)) return Result.success()
        val since = prefs.getLong("since", System.currentTimeMillis() / 1000)
        var newest = since
        val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val pathColumn = if (Build.VERSION.SDK_INT >= 29) MediaStore.Images.Media.RELATIVE_PATH else MediaStore.Images.Media.DATA
        try {
            ctx.contentResolver.query(
                uri,
                arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_ADDED, MediaStore.Images.Media.MIME_TYPE, MediaStore.Images.Media.SIZE),
                "${MediaStore.Images.Media.DATE_ADDED} > ? AND $pathColumn LIKE ?",
                arrayOf(since.toString(), "%Screenshots%"),
                "${MediaStore.Images.Media.DATE_ADDED} ASC",
            )?.use { c ->
                var count = 0
                while (c.moveToNext() && count < 10) {
                    val added = c.getLong(1)
                    newest = maxOf(newest, added)
                    if (c.getLong(3) > Inbox.MAX_BYTES) continue
                    val item = ContentUris.withAppendedId(uri, c.getLong(0))
                    val bytes = ctx.contentResolver.openInputStream(item)?.use { it.readBytes() } ?: continue
                    if (Inbox.add(ctx, "image", c.getString(2) ?: "image/png", bytes, "screenshot", createdAt = added * 1000)) count++
                }
                if (count > 0) UploadWorker.enqueue(ctx)
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "photo permission revoked; screenshot import stopped")
            prefs.edit().putBoolean("enabled", false).apply()
            return Result.success()
        }
        prefs.edit().putLong("since", newest).apply()
        // APPEND: REPLACE here would cancel this very run before it reports success (seen on API 35).
        arm(ctx, ExistingWorkPolicy.APPEND_OR_REPLACE)
        return Result.success()
    }

    companion object {
        private const val NAME = "clipply-screenshots"

        fun setEnabled(ctx: Context, enabled: Boolean) {
            val prefs = ctx.getSharedPreferences("clipply.screenshots", Context.MODE_PRIVATE)
            // Starting now: existing screenshots are never imported.
            prefs.edit().putBoolean("enabled", enabled).putLong("since", System.currentTimeMillis() / 1000).apply()
            if (enabled) arm(ctx, ExistingWorkPolicy.REPLACE) else WorkManager.getInstance(ctx).cancelUniqueWork(NAME)
        }

        /**
         * Runs the import once now. Some vendors (ColorOS, MIUI) force-stop an app swiped from recents,
         * which cancels its content-trigger job; screenshots taken meanwhile are picked up here when
         * Clipply is opened again (the query takes everything newer than the last import).
         */
        fun catchUp(ctx: Context) {
            if (!ctx.getSharedPreferences("clipply.screenshots", Context.MODE_PRIVATE).getBoolean("enabled", false)) return
            WorkManager.getInstance(ctx).enqueueUniqueWork("$NAME-catch-up", ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<ScreenshotWorker>().build())
        }

        private fun arm(ctx: Context, policy: ExistingWorkPolicy) {
            val constraints = Constraints.Builder()
                .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
                .setTriggerContentUpdateDelay(2, TimeUnit.SECONDS)
                .setTriggerContentMaxDelay(10, TimeUnit.SECONDS)
                .build()
            val req = OneTimeWorkRequestBuilder<ScreenshotWorker>().setConstraints(constraints).build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(NAME, policy, req)
        }
    }
}
