package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// encryptField encrypts plaintext with AES-256-GCM.
// Returns base64(nonce || ciphertext || tag).
func encryptField(plaintext []byte, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("aes.NewCipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("cipher.NewGCM: %w", err)
	}

	// Generate a random 12-byte nonce (GCM standard).
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}

	// gcm.Seal appends the ciphertext (and tag) to the nonce slice.
	// Result: nonce || ciphertext || tag
	sealed := gcm.Seal(nonce, nonce, plaintext, nil)

	return base64.StdEncoding.EncodeToString(sealed), nil
}

// decryptField decrypts a base64-encoded AES-256-GCM field.
// The encoded format is base64(nonce || ciphertext || tag).
func decryptField(encoded string, key []byte) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("base64 decode: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("aes.NewCipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("cipher.NewGCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}

	// gcm.Open(out, nonce, ciphertext, additionalData...)
	plaintext, err := gcm.Open(nil, data[:nonceSize], data[nonceSize:], nil)
	if err != nil {
		return nil, fmt.Errorf("gcm.Open: %w", err)
	}
	return plaintext, nil
}
