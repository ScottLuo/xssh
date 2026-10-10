// Package store provides encrypted SQLite persistence (SQLCipher 4).
//
// It manages host card data and application settings through
// HostRepo and SettingsRepo interfaces, with scrypt key derivation
// and AES-GCM field-level encryption for defense in depth.
package store
