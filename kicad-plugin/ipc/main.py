# Send to KiLive - IPC API plugin (KiCad 9 and later; enable the API server in Preferences > Plugins)
#
# Copies the open project (board as last saved, its schematics and project file) to the clipboard for KiLive.
# In KiLive, press Ctrl+V (Cmd+V on a Mac) on any page. The same text is saved as a .noeti file you can drag onto Noeti.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import noeti_common as nc  # noqa: E402

NOETI_URL = "__NOETI_URL__"


def _say(msg, offer_open=False):
    try:
        import tkinter
        from tkinter import messagebox
        root = tkinter.Tk()
        root.withdraw()
        if offer_open and NOETI_URL.startswith("http"):
            if messagebox.askyesno("Send to KiLive", msg + "\n\nOpen KiLive now?"):
                import webbrowser
                webbrowser.open(NOETI_URL)
        else:
            messagebox.showinfo("Send to KiLive", msg)
        root.destroy()
    except Exception:
        print("Send to KiLive: " + msg)


def _board_path():
    from kipy import KiCad
    kicad = KiCad()
    board = kicad.get_board()
    doc = board.document
    root, name = "", ""
    try:
        root = doc.project.path
    except Exception:
        pass
    if not root:
        try:
            root = kicad.get_project(doc).path
        except Exception:
            pass
    try:
        name = doc.board_filename
    except Exception:
        name = ""
    name = name or getattr(board, "name", "") or ""
    path = name if os.path.isabs(name) else os.path.join(root or os.getcwd(), name)
    version = ""
    try:
        version = str(kicad.get_version())
    except Exception:
        pass
    return path, version


def main():
    try:
        path, version = _board_path()
    except Exception as e:
        _say("Could not reach KiCad through its API (%s). Check Preferences > Plugins > Enable KiCad API." % e)
        return
    if not path or not os.path.isfile(path):
        _say("Save the board first: KiLive needs its project folder to find the schematics.")
        return
    try:
        project, files = nc.collect(path)
        payload = nc.encode(project, files, version)
    except Exception as e:
        _say("Could not prepare the project: %s" % e)
        return
    copied = nc.os_clipboard(payload)
    saved = ""
    try:
        saved = nc.save_copy(project, payload)
    except Exception:
        pass
    sch = sum(1 for k in files if k.lower().endswith(".kicad_sch"))
    msg = "%s: the board as last saved, %d schematic sheet%s (%s).\n\n" % (project, sch, "" if sch == 1 else "s", nc.size_text(len(payload)))
    msg += "Copied. In KiLive, press Ctrl+V (Cmd+V on a Mac) on any page." if copied else "The clipboard was not available. Drag the .noeti file onto KiLive instead."
    if saved:
        msg += "\n\nSaved as " + saved
    _say(msg, offer_open=True)


if __name__ == "__main__":
    main()
