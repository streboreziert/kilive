# Send to KiLive - a PCB Editor action plugin (KiCad 6 to 10)
#
# One click copies the open project (board as it is now, plus its schematics and project file) to the clipboard.
# In KiLive, press Ctrl+V (Cmd+V on a Mac) on any page: KiLive offers to update the board you have open from it,
# or makes a new board. The same text is also saved as a .noeti file you can drag onto Noeti.
import os
import shutil
import tempfile
import webbrowser

import pcbnew

try:
    import wx
except Exception:  # pragma: no cover - KiCad always ships wx, the tests do not
    wx = None

from . import noeti_common as nc

NOETI_URL = "__NOETI_URL__"


def _kicad_version():
    try:
        return pcbnew.GetBuildVersion()
    except Exception:
        try:
            return pcbnew.Version()
        except Exception:
            return ""


def _major(v):
    try:
        return int(str(v).lstrip("(").split(".")[0])
    except Exception:
        return 0


def _board_text(board):
    """The board as it is in the editor (unsaved edits included) where KiCad allows it; else the saved file."""
    path = board.GetFileName()
    ver = _kicad_version()
    if _major(ver) >= 7:
        tmpdir = tempfile.mkdtemp(prefix="noeti-")
        tmp = os.path.join(tmpdir, os.path.basename(path) or "board.kicad_pcb")
        try:
            # third argument: skip the project settings, so the open project stays where it is
            if pcbnew.SaveBoard(tmp, board, True) is not False and os.path.isfile(tmp):
                with open(tmp, "r", encoding="utf-8", errors="replace") as f:
                    return f.read(), False
        except Exception:
            pass
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    # KiCad 6 (its SaveBoard would move the project), or the copy failed: the file as last saved
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read(), True


def _copy(text):
    if wx is not None:
        try:
            cb = wx.TheClipboard
            if cb.Open():
                try:
                    cb.SetData(wx.TextDataObject(text))
                    cb.Flush()
                    return True
                finally:
                    cb.Close()
        except Exception:
            pass
    return nc.os_clipboard(text)


def _tell(msg, title="Send to KiLive", offer_open=False):
    if wx is None:
        print(title + ": " + msg)
        return False
    style = wx.OK | wx.ICON_INFORMATION
    if offer_open and NOETI_URL.startswith("http"):
        dlg = wx.MessageDialog(None, msg, title, wx.YES_NO | wx.ICON_INFORMATION)
        try:
            dlg.SetYesNoLabels("Open KiLive", "Done")
        except Exception:
            pass
        ok = dlg.ShowModal() == wx.ID_YES
        dlg.Destroy()
        return ok
    dlg = wx.MessageDialog(None, msg, title, style)
    dlg.ShowModal()
    dlg.Destroy()
    return False


class NoetiSend(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Send to KiLive"
        self.category = "KiLive"
        self.description = "Copy this project (board and schematics) for KiLive: 3D, design checks and live simulation"
        self.show_toolbar_button = True
        here = os.path.dirname(__file__)
        self.icon_file_name = os.path.join(here, "noeti.png")
        self.dark_icon_file_name = os.path.join(here, "noeti_dark.png")

    def Run(self):
        board = pcbnew.GetBoard()
        path = board.GetFileName() if board else ""
        if not path:
            _tell("Save the board first: KiLive needs its project folder to find the schematics.")
            return
        try:
            pcb_text, from_disk = _board_text(board)
            project, files = nc.collect(path, pcb_text)
            payload = nc.encode(project, files, _kicad_version(), unsaved=False)
        except Exception as e:  # report, never crash the editor
            _tell("Could not prepare the project: %s" % e)
            return
        copied = _copy(payload)
        saved = ""
        try:
            saved = nc.save_copy(project, payload)
        except Exception:
            pass
        sch = sum(1 for k in files if k.lower().endswith(".kicad_sch"))
        lines = ["%s: the board%s, %d schematic sheet%s (%s)." % (project, " as last saved" if from_disk else "", sch, "" if sch == 1 else "s", nc.size_text(len(payload)))]
        if copied:
            lines.append("")
            lines.append("Copied. In KiLive, press Ctrl+V (Cmd+V on a Mac) on any page.")
            lines.append("KiLive asks whether to update the board you have open or make a new one.")
        else:
            lines.append("")
            lines.append("The clipboard was not available. Drag this file onto KiLive instead:")
        if saved:
            lines.append("")
            lines.append(("Also saved as " if copied else "") + saved)
        if _tell("\n".join(lines), offer_open=True):
            try:
                webbrowser.open(NOETI_URL)
            except Exception:
                pass
