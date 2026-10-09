package main

import (
	"context"

	"github.com/scottluo/xssh/frontend"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:              "xssh",
		Width:              1200,
		Height:             800,
		MinWidth:           800,
		MinHeight:          500,
		BackgroundColour:   &options.RGBA{R: 30, G: 30, B: 30, A: 1},
		StartHidden:        true,
		OnStartup:          app.startup,
		OnShutdown:         app.shutdown,
		OnDomReady:         app.domReady,
		Bind: []interface{}{
			app,
		},
		AssetServer: &assetserver.Options{
			Assets: frontend.Assets,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}

// domReady is called when the DOM is ready in the frontend.
func (a *App) domReady(ctx context.Context) {
	// Reserved for frontend initialization signals.
}
