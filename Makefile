.PHONY: dev build test clean

dev:
	wails dev -tags webkit2_41

build:
	wails build -tags webkit2_41

test:
	go test ./...

clean:
	rm -rf build/
