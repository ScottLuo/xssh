package frontend

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// Assets is the embedded filesystem used by Wails asset server.
// It serves files from the "dist" directory (Vite build output).
var Assets fs.FS

func init() {
	var err error
	Assets, err = fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
}
