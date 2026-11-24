package co.lazycoders.clipply

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** What the app computes for a captured image (services/images.ts), for the background upload. */
class DecodedImage(val rgba: ByteArray, val thumb: ByteArray)

object Images {
    /** Decoded pixels are held in memory twice; larger photos wait for the app. */
    private const val MAX_PIXELS = 24_000_000L
    private const val MAX_THUMB_BYTES = 40 * 1024
    private val THUMB_STEPS = listOf(320 to 80, 320 to 60, 240 to 60, 180 to 50, 120 to 50)

    /** null when Android cannot decode it or it is too large: the app takes it when it opens. */
    fun decode(data: ByteArray): DecodedImage? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outWidth.toLong() * bounds.outHeight > MAX_PIXELS) return null
        val opts = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            // The WebView's canvas is sRGB too, so the same image hashes the same on both paths.
            if (Build.VERSION.SDK_INT >= 26) inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
        }
        val raw = BitmapFactory.decodeByteArray(data, 0, data.size, opts) ?: return null
        val bitmap = upright(raw, data)
        return DecodedImage(rgba(bitmap), thumb(bitmap) ?: return null)
    }

    /** Camera photos carry their rotation as EXIF; browsers apply it, BitmapFactory does not. */
    private fun upright(b: Bitmap, data: ByteArray): Bitmap {
        val o = runCatching { ExifInterface(data.inputStream()).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1)
        val m = Matrix()
        when (o) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.setRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.setRotate(-90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
            else -> return b
        }
        return Bitmap.createBitmap(b, 0, 0, b.width, b.height, m, false)
    }

    /** RGBA with straight alpha, like canvas getImageData. */
    private fun rgba(b: Bitmap): ByteArray {
        val out = ByteArray(b.width * b.height * 4)
        if (!b.hasAlpha()) {
            b.copyPixelsToBuffer(ByteBuffer.wrap(out))
            return out
        }
        val row = IntArray(b.width)
        var i = 0
        for (y in 0 until b.height) {
            b.getPixels(row, 0, b.width, 0, y, b.width, 1)
            for (p in row) {
                out[i++] = (p shr 16).toByte()
                out[i++] = (p shr 8).toByte()
                out[i++] = p.toByte()
                out[i++] = (p ushr 24).toByte()
            }
        }
        return out
    }

    private fun thumb(b: Bitmap): ByteArray? {
        for ((width, quality) in THUMB_STEPS) {
            val scale = minOf(1.0, width.toDouble() / b.width)
            val t = Bitmap.createScaledBitmap(b, maxOf(1, Math.round(b.width * scale).toInt()), maxOf(1, Math.round(b.height * scale).toInt()), true)
            val out = ByteArrayOutputStream()
            t.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= MAX_THUMB_BYTES) return out.toByteArray()
        }
        return null
    }
}
