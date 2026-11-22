package co.lazycoders.clipply

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secrets (vault keyring, device keys, session) and the capture inbox, encrypted with an
 * AES-256-GCM key that lives in the Android Keystore and never leaves it. Files sit in
 * noBackupFilesDir and the app disables backup, so wrapped blobs never outlive the key.
 */
object SecureStore {
    private const val ALIAS = "clipply.secure.v1"
    private val NAME = Regex("^[a-z][a-z0-9.]{0,40}$")

    @Synchronized
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as SecretKey?)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    /** Output: iv(12) || ciphertext+tag. */
    fun encrypt(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return c.iv + c.doFinal(plain)
    }

    fun decrypt(blob: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 0, 12))
        return c.doFinal(blob, 12, blob.size - 12)
    }

    private fun file(ctx: Context, name: String): File {
        require(NAME.matches(name)) { "invalid secure store name" }
        return File(File(ctx.noBackupFilesDir, "secure").apply { mkdirs() }, "$name.bin")
    }

    /** Atomic write via rename so a crash never leaves a truncated secret. */
    fun put(ctx: Context, name: String, value: String) {
        val f = file(ctx, name)
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeBytes(encrypt(value.toByteArray(Charsets.UTF_8)))
        if (!tmp.renameTo(f)) throw IllegalStateException("could not store $name")
    }

    fun get(ctx: Context, name: String): String? {
        val f = file(ctx, name)
        if (!f.exists()) return null
        return String(decrypt(f.readBytes()), Charsets.UTF_8)
    }

    fun remove(ctx: Context, name: String) {
        file(ctx, name).delete()
    }
}
