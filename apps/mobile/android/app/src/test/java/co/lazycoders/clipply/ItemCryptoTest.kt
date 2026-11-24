package co.lazycoders.clipply

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.security.SecureRandom

/** Proves the Kotlin encryption is byte-compatible with packages/crypto (vectors written by its tests). */
class ItemCryptoTest {
    private val vector = JSONObject(File(System.getProperty("clipply.vectors")!!).readText())
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private val vk = hex(vector.getString("vaultKeyEpoch1"))
    private val keyring = JSONObject().put("v", 1).put("current", 1).put("keys", JSONObject().put("1", ItemCrypto.b64url(vk))).toString()

    @Test fun decryptsTypeScriptVectors() {
        val id = vector.getString("itemId")
        val dek = ItemCrypto.open(vk, hex(vector.getString("wrappedDek")), ItemCrypto.aad(id, "dek"))
        assertArrayEquals(hex(vector.getString("dek")), dek)
        val body = ItemCrypto.unpad(ItemCrypto.open(dek, hex(vector.getString("bodyCiphertext")), ItemCrypto.aad(id, "body")))
        assertArrayEquals(hex(vector.getString("body")), body)
        assertEquals(vector.getJSONObject("aad").getString("body"), String(ItemCrypto.aad(id, "body")))
    }

    @Test fun keyedHashMatchesTypeScript() {
        assertEquals(vector.getString("contentHash"), ItemCrypto(keyring).keyedHash(hex(vector.getString("body"))))
    }

    @Test fun encryptsItemsTheTypeScriptSideCanOpen() {
        val crypto = ItemCrypto(keyring)
        val item = crypto.encryptText("Hello from Android\r\n", "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", 1_700_000_000_000, SecureRandom())!!
        val id = item.getString("id")
        assert(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(id))
        val dek = ItemCrypto.open(vk, ItemCrypto.b64urlDecode(item.getString("dek")), ItemCrypto.aad(id, "dek"))
        val meta = JSONObject(String(ItemCrypto.unpad(ItemCrypto.open(dek, ItemCrypto.b64urlDecode(item.getString("meta")), ItemCrypto.aad(id, "meta")))))
        assertEquals("text", meta.getString("kind"))
        assertEquals(crypto.keyedHash("text\u0000Hello from Android".toByteArray()), meta.getString("contentHash"))
        val body = ItemCrypto.unpad(ItemCrypto.open(dek, ItemCrypto.b64urlDecode(item.getString("body")), ItemCrypto.aad(id, "body")))
        assertEquals("Hello from Android\r\n", String(body))
        assertEquals(256, ItemCrypto.open(dek, ItemCrypto.b64urlDecode(item.getString("body")), ItemCrypto.aad(id, "body")).size)
        // Tampering and field swaps are rejected.
        assertThrows(Exception::class.java) { ItemCrypto.open(dek, ItemCrypto.b64urlDecode(item.getString("body")), ItemCrypto.aad(id, "meta")) }
    }

    @Test fun encryptsImagesAndFilesAsBlobs() {
        val crypto = ItemCrypto(keyring)
        val data = ByteArray(70_000) { (it % 251).toByte() }
        val pixels = ByteArray(64) { it.toByte() }
        val made = crypto.encryptBlob("image", "image/png", data, pixels, byteArrayOf(9, 8, 7), null, "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", 1_700_000_000_000)!!
        val dek = ItemCrypto.open(vk, ItemCrypto.b64urlDecode(made.item.getString("dek")), ItemCrypto.aad(made.id, "dek"))
        fun part(name: String, box: ByteArray) = ItemCrypto.unpad(ItemCrypto.open(dek, box, ItemCrypto.aad(made.id, name)))
        val meta = JSONObject(String(part("meta", ItemCrypto.b64urlDecode(made.item.getString("meta")))))
        assertEquals("image", meta.getString("kind"))
        assertEquals(data.size, meta.getInt("size"))
        assertEquals(crypto.keyedHash("image\u0000".toByteArray() + pixels), meta.getString("contentHash"))
        assertArrayEquals(data, part("body", made.body))
        assertArrayEquals(byteArrayOf(9, 8, 7), part("thumb", ItemCrypto.b64urlDecode(made.item.getString("thumb"))))

        val file = crypto.encryptBlob("file", "application/pdf", data, data, null, "অ".repeat(300), "d", 1)!!
        assert(!file.item.has("thumb"))
        assert(file.item.getString("meta").length <= ItemCrypto.META_MAX)
        assertNull(crypto.encryptBlob("file", "x/y", ByteArray(ItemCrypto.MAX_CONTENT_BYTES + 1), data, null, "a", "d", 1))
        assert(crypto.encryptBlob("file", "x/y", ByteArray(ItemCrypto.MAX_CONTENT_BYTES), data, null, "a", "d", 1)!!.body.size <= 10 * 1024 * 1024)
    }

    @Test fun classifiesUrlsAndSkipsEmpty() {
        val crypto = ItemCrypto(keyring)
        val item = crypto.encryptText("https://clipply.dev", "d", 1, SecureRandom())!!
        val dek = ItemCrypto.open(vk, ItemCrypto.b64urlDecode(item.getString("dek")), ItemCrypto.aad(item.getString("id"), "dek"))
        val meta = JSONObject(String(ItemCrypto.unpad(ItemCrypto.open(dek, ItemCrypto.b64urlDecode(item.getString("meta")), ItemCrypto.aad(item.getString("id"), "meta")))))
        assertEquals("url", meta.getString("kind"))
        assertNull(crypto.encryptText(" \r\n", "d", 1, SecureRandom()))
    }
}
