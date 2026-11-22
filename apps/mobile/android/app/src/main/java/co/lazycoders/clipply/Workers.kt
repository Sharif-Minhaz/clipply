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
}

/**
 * Uploads text items captured while the app was closed. One unique job, network-constrained,
 * batched, with exponential backoff; it never polls and exits when the inbox has no text.
 * Images and anything it cannot handle wait for the app (thumbnails and blob uploads live in JS).
 */
class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // Sync paused on this device: captures stay in the inbox until the app imports them.
        if (!UploadWorker.isEnabled(ctx)) return Result.success()
        val config = SecureStore.get(ctx, "config")?.let(::JSONObject) ?: return Result.success()
        var session = SecureStore.get(ctx, "session")?.let(::JSONObject) ?: return Result.success()
        val vault = SecureStore.get(ctx, "vault")?.let(::JSONObject) ?: return Result.success()
        val api = config.getString("apiUrl").trimEnd('/')
        val entries = Inbox.list(ctx).filter { it.second.getString("type") == "text" }.take(50)
        if (entries.isEmpty()) return Result.success()

        return try {
            if (session.getLong("accessExpiresAt") - 60_000 < System.currentTimeMillis()) {
                val auth = Http.json("POST", "$api/v1/auth/refresh", JSONObject().put("refreshToken", session.getString("refreshToken")), null)
                session = JSONObject()
                    .put("userId", session.getString("userId")).put("email", session.getString("email"))
                    .put("refreshToken", auth.getString("refreshToken")).put("accessToken", auth.getString("accessToken"))
                    .put("accessExpiresAt", auth.getLong("accessExpiresAt"))
                SecureStore.put(ctx, "session", session.toString())
            }
            val crypto = ItemCrypto(String(ItemCrypto.b64urlDecode(vault.getString("keyring")), Charsets.UTF_8))
            val deviceId = vault.getString("deviceId")
            val ops = JSONArray()
            val sent = mutableListOf<java.io.File>()
            for ((file, e) in entries) {
                val text = String(android.util.Base64.decode(e.getString("data"), android.util.Base64.NO_WRAP), Charsets.UTF_8)
                val item = crypto.encryptText(text, deviceId, e.getLong("createdAt")) ?: continue
                ops.put(JSONObject().put("type", "upsert").put("opId", UUID.randomUUID().toString()).put("baseRev", 0).put("item", item))
                sent += file
            }
            if (ops.length() == 0) return Result.success()
            val res = Http.json("POST", "$api/v1/sync/push", JSONObject().put("ops", ops), session.getString("accessToken"))
            val results = res.getJSONArray("results")
            for (i in 0 until results.length()) {
                // applied → the server has it and the app will pull it; anything else stays for the app to handle.
                if (results.getJSONObject(i).getString("status") == "applied") sent[i].delete()
            }
            Result.success()
        } catch (e: Http.Status) {
            Log.w(TAG, "upload failed: HTTP ${e.code}")
            // 401/403: the session or device is gone; the app will explain. Others: retry with backoff.
            if (e.code == 401 || e.code == 403 || e.code == 400) Result.success() else Result.retry()
        } catch (e: IOException) {
            Result.retry()
        }
    }

    companion object {
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
