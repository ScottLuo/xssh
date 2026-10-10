package store

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"testing"
)

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	key := testKey(t)
	plaintexts := []string{
		"hello world",
		"mypassword123",
		"a longer password with special chars !@#$%^&*()",
		"Ünïcödé tëxt 日本語",
	}

	for i, plaintext := range plaintexts {
		t.Run(fmt.Sprintf("case_%d", i), func(t *testing.T) {
			enc, err := encryptField([]byte(plaintext), key)
			if err != nil {
				t.Fatalf("encryptField: %v", err)
			}
			dec, err := decryptField(enc, key)
			if err != nil {
				t.Fatalf("decryptField: %v", err)
			}
			if string(dec) != plaintext {
				t.Fatalf("round-trip mismatch: got %q, want %q", string(dec), plaintext)
			}
		})
	}
}

func TestEncryptDecrypt_EmptyPlaintext(t *testing.T) {
	key := testKey(t)

	enc, err := encryptField([]byte{}, key)
	if err != nil {
		t.Fatalf("encryptField empty: %v", err)
	}
	dec, err := decryptField(enc, key)
	if err != nil {
		t.Fatalf("decryptField: %v", err)
	}
	if len(dec) != 0 {
		t.Fatalf("expected empty slice, got %d bytes", len(dec))
	}
}

func TestEncrypt_DifferentNonces(t *testing.T) {
	key := testKey(t)
	plaintext := "same plaintext"

	enc1, err := encryptField([]byte(plaintext), key)
	if err != nil {
		t.Fatalf("encrypt 1: %v", err)
	}
	enc2, err := encryptField([]byte(plaintext), key)
	if err != nil {
		t.Fatalf("encrypt 2: %v", err)
	}
	if enc1 == enc2 {
		t.Fatal("expected different ciphertexts (random nonce)")
	}
}

func TestDecrypt_WrongKey(t *testing.T) {
	keyA := testKey(t)
	keyB := make([]byte, 32)
	for i := range keyB {
		keyB[i] = byte(i + 100)
	}

	enc, err := encryptField([]byte("secret"), keyA)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	_, err = decryptField(enc, keyB)
	if err == nil {
		t.Fatal("expected error with wrong key, got nil")
	}
}

func TestDecrypt_InvalidBase64(t *testing.T) {
	key := testKey(t)
	_, err := decryptField("not-valid-base64!!!", key)
	if err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestDecrypt_CiphertextTooShort(t *testing.T) {
	key := testKey(t)
	// Encode a short byte slice as base64 (less than 12 bytes = nonce size).
	short := base64.StdEncoding.EncodeToString([]byte("short"))
	_, err := decryptField(short, key)
	if err == nil {
		t.Fatal("expected error for too-short ciphertext")
	}
}

func TestEncrypt_ValidBase64Output(t *testing.T) {
	key := testKey(t)
	enc, err := encryptField([]byte("test"), key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	decoded, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		t.Fatalf("output is not valid base64: %v", err)
	}
	// minimum: nonce(12) + plaintext(0) + tag(16) = 28
	if len(decoded) < 28 {
		t.Fatalf("decoded too short: %d bytes", len(decoded))
	}
}

func TestEncryptDecrypt_LargerPlaintext(t *testing.T) {
	key := testKey(t)
	plaintext := bytes.Repeat([]byte("a"), 1024)

	enc, err := encryptField(plaintext, key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	dec, err := decryptField(enc, key)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(dec, plaintext) {
		t.Fatal("round-trip mismatch for 1KB plaintext")
	}
}
