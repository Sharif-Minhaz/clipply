package co.lazycoders.clipply

import com.google.crypto.tink.subtle.XChaCha20Poly1305
import org.bouncycastle.crypto.digests.Blake2bDigest
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64

/**
 * The subset of @clipply/crypto the background upload needs: encrypt one new text item in format
 * encVersion 1 (docs/encryption.md §4). Pure JVM so it is unit-tested against
 * packages/crypto/vectors/item-v1.json. It never handles key exchange or rotation.
 */
class ItemCrypto(keyringJson: String) {
    val current: Int
    private val keys: Map<Int, ByteArray>

    init {
        val j = JSONObject(keyringJson)
        require(j.getInt("v") == 1) { "unsupported keyring version" }
        current = j.getInt("current")
        val k = j.getJSONObject("keys")
        keys = k.keys().asSequence().associate { it.toInt() to b64urlDecode(k.getString(it)) }
        require(keys[current]?.size == 32 && keys[1]?.size == 32) { "malformed keyring" }
    }

    /** Keyed BLAKE2b-256 with the hash subkey derived from epoch 1 (stable across rotations). */
    fun keyedHash(data: ByteArray): String {
        val d = Blake2bDigest(kdf(keys.getValue(1), 1, "clphash_"), 32, null, null)
        d.update(data, 0, data.size)
        val out = ByteArray(32)
        d.doFinal(out, 0)
        return out.joinToString("") { "%02x".format(it) }
    }

    /** Builds the EncryptedItem JSON for a text clip, or null when its body would not fit inline. */
    fun encryptText(text: String, deviceId: String, now: Long, random: SecureRandom = SecureRandom()): JSONObject? {
        val id = uuidv7(now, random)
        val norm = normalizeText(text)
        if (norm.isEmpty()) return null
        val body = text.toByteArray(Charsets.UTF_8)
        val hash = keyedHash("text\u0000".toByteArray(Charsets.UTF_8) + norm.toByteArray(Charsets.UTF_8))
        val dek = ByteArray(32).also { random.nextBytes(it) }
        val meta = JSONObject()
            .put("kind", if (isUrl(norm)) "url" else "text")
            .put("mime", "text/plain;charset=utf-8")
            .put("createdAt", now)
            .put("originDeviceId", deviceId)
            .put("size", body.size)
            .put("contentHash", hash)
            .put("favorite", false)
            .put("pinned", false)
        val bodyB64 = b64url(seal(dek, pad(body), aad(id, "body")))
        if (bodyB64.length > INLINE_BODY_MAX) return null
        return JSONObject()
            .put("id", id).put("encVersion", 1).put("keyEpoch", current)
            .put("dek", b64url(seal(keys.getValue(current), dek, aad(id, "dek"))))
            .put("meta", b64url(seal(dek, pad(meta.toString().toByteArray(Charsets.UTF_8)), aad(id, "meta"))))
            .put("body", bodyB64)
    }

    companion object {
        const val INLINE_BODY_MAX = 65_536

        fun aad(itemId: String, part: String) = "clipply/v1/$itemId/$part".toByteArray(Charsets.UTF_8)

        /** XChaCha20-Poly1305-IETF; Tink's output is nonce(24) || ciphertext || tag, as in TS. */
        fun seal(key: ByteArray, plain: ByteArray, aad: ByteArray): ByteArray = XChaCha20Poly1305(key).encrypt(plain, aad)

        fun open(key: ByteArray, box: ByteArray, aad: ByteArray): ByteArray = XChaCha20Poly1305(key).decrypt(box, aad)

        /** libsodium crypto_kdf_derive_from_key: BLAKE2b(key, salt = LE64(id) || 0^8, personal = ctx || 0^8). */
        fun kdf(master: ByteArray, subkeyId: Long, ctx: String): ByteArray {
            val salt = ByteArray(16).also { for (i in 0 until 8) it[i] = (subkeyId ushr (8 * i)).toByte() }
            val personal = ByteArray(16).also { ctx.toByteArray(Charsets.US_ASCII).copyInto(it) }
            val d = Blake2bDigest(master, 32, salt, personal)
            val out = ByteArray(32)
            d.doFinal(out, 0)
            return out
        }

        /** Same buckets as packages/crypto aead.ts: <4 KiB → 256 B, <1 MiB → 4 KiB, else 64 KiB. */
        fun pad(data: ByteArray): ByteArray {
            val block = if (data.size < 4096) 256 else if (data.size < (1 shl 20)) 4096 else 65536
            val out = ByteArray((data.size / block + 1) * block)
            data.copyInto(out)
            out[data.size] = 0x80.toByte()
            return out
        }

        fun unpad(p: ByteArray): ByteArray {
            var end = p.size - 1
            while (end >= 0 && p[end] == 0.toByte()) end--
            require(end >= 0 && p[end] == 0x80.toByte()) { "invalid padding" }
            return p.copyOf(end)
        }

        fun normalizeText(t: String) = t.replace(Regex("\r\n?"), "\n").trimEnd()

        fun isUrl(t: String) = Regex("^https?://\\S+$", RegexOption.IGNORE_CASE).matches(t.trim())

        fun uuidv7(now: Long, random: SecureRandom): String {
            val b = ByteArray(16).also { random.nextBytes(it) }
            for (i in 0 until 6) b[i] = (now ushr (8 * (5 - i))).toByte()
            b[6] = ((b[6].toInt() and 0x0f) or 0x70).toByte()
            b[8] = ((b[8].toInt() and 0x3f) or 0x80).toByte()
            val h = b.joinToString("") { "%02x".format(it) }
            return "${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}"
        }

        fun b64url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
        fun b64urlDecode(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
    }
}
