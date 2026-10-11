// Package sshmgr provides SSH connection management, PTY sessions, and I/O pumping.
//
// It maintains a ConnectionManager that reuses one *ssh.Client per host,
// and creates a new *ssh.Session with PTY per terminal tab.
package sshmgr
