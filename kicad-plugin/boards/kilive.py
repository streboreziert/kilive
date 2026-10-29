# KiLive for KiCad - PCB Editor action plugin (KiCad 7 to 9; KiCad 6 shows the board as last saved)
#
# One click opens the open project in KiLive, served from this computer: PCB, schematic, 3D, checks,
# live simulation. Nothing leaves the machine. Saving in KiCad, or pressing the button again, updates the open tab.
import os
import shutil
import tempfile
import webbrowser

import pcbnew

try:
    import wx
except Exception:  # pragma: no cover - KiCad always ships wx
    wx = None

from . import noeti_common as nc
from . import noeti_server as srv


def _kicad_version():
    for f in ("GetBuildVersion", "Version"):
        try:
            return getattr(pcbnew, f)()
        except Exception:
            pass
    return ""


def _major(v):
    try:
        return int(str(v).lstrip("(").split(".")[0])
    except Exception:
        return 0


def _board_text(board):
    """The board as it is in the editor (unsaved edits included) on KiCad 7+; else the saved file."""
    path = board.GetFileName()
    if _major(_kicad_version()) >= 7:
        tmpdir = tempfile.mkdtemp(prefix="noeti-")
        tmp = os.path.join(tmpdir, os.path.basename(path) or "board.kicad_pcb")
        try:
            if pcbnew.SaveBoard(tmp, board, True) is not False and os.path.isfile(tmp):
                with open(tmp, "r", encoding="utf-8", errors="replace") as f:
                    return f.read()
        except Exception:
            pass
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def _tell(msg):
    if wx is None:
        print("KiLive: " + msg)
        return
    dlg = wx.MessageDialog(None, msg, "KiLive", wx.OK | wx.ICON_INFORMATION)
    dlg.ShowModal()
    dlg.Destroy()


class KiLive(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "KiLive"
        self.category = "KiLive"
        self.description = "Open this board in KiLive: PCB, schematic, 3D and live circuit simulation, in your browser, offline"
        self.show_toolbar_button = True
        here = os.path.dirname(__file__)
        self.icon_file_name = os.path.join(here, "noeti.png")
        self.dark_icon_file_name = os.path.join(here, "noeti_dark.png")

    def Run(self):
        board = pcbnew.GetBoard()
        path = board.GetFileName() if board else ""
        if not path:
            _tell("Save the board first: KiLive reads the schematics from the project folder.")
            return
        if not os.path.isdir(srv.WEB):
            _tell("The plugin is incomplete (web folder missing). Reinstall it.")
            return
        try:
            name, files = nc.collect(path, _board_text(board))
            was_open = srv.page_open()
            base = srv.start()
            srv.set_project(path, name, files)
        except Exception as e:  # report, never crash the editor
            _tell("Could not open the board: %s" % e)
            return
        if not was_open:  # an open tab polls and updates by itself
            try:
                webbrowser.open(base + "#kicad")
            except Exception:
                _tell("Open " + base + "#kicad in your browser.")
