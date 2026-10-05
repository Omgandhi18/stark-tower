import { File, Folder } from "lucide-react";
import { cx, ICON_SIZE, ICON_STROKE } from "../../design";
import type { PathEntry } from "../../lib/types";
import { folderName } from "../../stores/workspace";
import { baseName, dirName, optionId, type ScanStatus } from "./fileMentions";

interface FilePickerProps {
  id: string;
  folder: string;
  status: ScanStatus;
  options: readonly PathEntry[];
  highlight: number;
  onPick: (entry: PathEntry) => void;
  onHighlight: (index: number) => void;
}

/** Files and folders matching the @mention being typed. */
export default function FilePicker({ id, folder, status, options, highlight, onPick, onHighlight }: FilePickerProps) {
  const note =
    status === "loading" && options.length === 0
      ? "Looking through the folder…"
      : status === "error"
        ? "This folder couldn't be read."
        : options.length === 0
          ? "No files or folders match."
          : null;
  return (
    <div className="file-picker">
      <div className="file-picker-head">
        <span>{folderName(folder)}</span>
        {status === "loading" && <span className="file-picker-scanning">Scanning</span>}
      </div>
      {note ? (
        <p className="file-picker-note">{note}</p>
      ) : (
        <ul id={id} role="listbox" aria-label={`Files in ${folderName(folder)}`} className="file-picker-list">
          {options.map((entry, i) => {
            const Icon = entry.dir ? Folder : File;
            const parent = dirName(entry.path);
            return (
              <li
                key={entry.path}
                id={optionId(id, i)}
                role="option"
                aria-selected={i === highlight}
                className={cx("file-option", i === highlight && "is-highlighted")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(entry);
                }}
                onMouseEnter={() => onHighlight(i)}
              >
                <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className={cx("file-option-icon", entry.dir && "is-dir")} />
                <span className="file-option-name">
                  {baseName(entry.path)}
                  {entry.dir ? "/" : ""}
                </span>
                {parent && <span className="file-option-path">{parent}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
