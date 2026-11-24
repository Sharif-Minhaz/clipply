package co.lazycoders.clipply

import android.content.Context
import java.io.File

/**
 * Encrypted chunks of large files (packages/sync-engine chunks.ts), one file per chunk. The app encrypted
 * them already; they stay out of SQLite because a row crosses the WebView bridge as one JSON array.
 */
object ChunkFiles {
    private val UUID = Regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")

    private fun root(ctx: Context) = File(ctx.noBackupFilesDir, "chunks")

    private fun dir(ctx: Context, id: String): File {
        require(UUID.matches(id)) { "not an item id" }
        return File(root(ctx), id)
    }

    fun put(ctx: Context, id: String, index: Int, data: ByteArray) {
        val d = dir(ctx, id).apply { mkdirs() }
        // Renamed into place, so a half-written chunk never looks complete.
        val tmp = File(d, "$index.tmp")
        tmp.writeBytes(data)
        if (!tmp.renameTo(File(d, "$index"))) throw java.io.IOException("could not store part $index")
    }

    fun get(ctx: Context, id: String, index: Int): ByteArray? = File(dir(ctx, id), "$index").takeIf { it.exists() }?.readBytes()

    fun has(ctx: Context, id: String, index: Int) = File(dir(ctx, id), "$index").exists()

    fun remove(ctx: Context, id: String) {
        dir(ctx, id).deleteRecursively()
    }

    fun ids(ctx: Context): List<String> = root(ctx).list()?.filter(UUID::matches) ?: emptyList()
}
