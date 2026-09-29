package files

import (
	"net/http"
	"strconv"

	. "github.com/mickael-kerjean/filestash/server/pkg/core"
	. "github.com/mickael-kerjean/filestash/server/pkg/kernel"
	. "github.com/mickael-kerjean/filestash/server/pkg/utils"
)

func FileChmod(ctx *App, res http.ResponseWriter, req *http.Request) {
	path, err := PathBuilder(ctx, req.URL.Query().Get("path"))
	if err != nil {
		Log.Debug("chmod::path '%s'", err.Error())
		SendErrorResult(res, err)
		return
	}
	modeStr := req.URL.Query().Get("perms")
	mode, parseErr := strconv.ParseInt(modeStr, 8, 32)
	if parseErr != nil {
		SendErrorResult(res, NewError("invalid perms parameter", 400))
		return
	}
	backend, ok := ctx.Backend.(interface{ Chmod(path string, perms int) error })
	if !ok {
		SendErrorResult(res, ErrNotImplemented)
		return
	}
	err = backend.Chmod(path, int(mode))
	if err != nil {
		Log.Debug("chmod::backend '%s'", err.Error())
		SendErrorResult(res, err)
		return
	}
	SendSuccessResult(res, nil)
}
