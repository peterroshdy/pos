import { useEffect, useState } from "react";
import { Download, Search, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";

type AuditLog = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  order_number: string | null;
  original_value: string | null;
  new_value: string | null;
  reason: string | null;
  created_at: string;
  user_name: string;
  user_name_ar: string;
};

export function AuditPage() {
  const { language, t } = useI18n();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [search, setSearch] = useState("");
  useEffect(() => {
    api<{ logs: AuditLog[] }>("/api/audit").then((data) => setLogs(data.logs));
  }, []);
  const filtered = logs.filter((log) =>
    `${log.action} ${log.user_name} ${log.order_number ?? ""} ${log.reason ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const exportLog = () => {
    const rows = [
      ["Time", "Employee", "Type", "Action", "Entity", "Order", "Reason"],
      ...filtered.map((log) => [
        log.created_at,
        log.user_name,
        log.entity_type,
        log.action,
        `${log.entity_type}:${log.entity_id}`,
        log.order_number ?? "",
        log.reason ?? "",
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    link.download = `test-and-coffee-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Accountability</span>
          <h2>{t("audit")}</h2>
          <p>A tamper-evident view of sensitive actions across this branch.</p>
        </div>
        <button className="soft-button" onClick={exportLog}>
          <Download size={18} /> Export log
        </button>
      </div>
      <section className="audit-intro">
        <span>
          <ShieldCheck />
        </span>
        <div>
          <strong>Financial activity cannot be silently deleted</strong>
          <p>
            Voids, discounts, receipt reprints, stock changes, logins, and
            transaction drawer openings are recorded with the employee, time,
            and values.
          </p>
        </div>
      </section>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <label>
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search activity, user, or order"
            />
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("time")}</th>
                <th>{t("user")}</th>
                <th>Type</th>
                <th>{t("action")}</th>
                <th>Reference</th>
                <th>Change</th>
                <th>{t("reason")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((log) => (
                <tr key={log.id}>
                  <td>{new Date(log.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}</td>
                  <td>
                    <strong>{language === "ar" ? log.user_name_ar : log.user_name}</strong>
                  </td>
                  <td>{log.entity_type}</td>
                  <td>
                    <span className="action-chip">
                      {log.action.replaceAll(".", " ")}
                    </span>
                  </td>
                  <td>
                    {log.order_number
                      ? `#${log.order_number}`
                      : `${log.entity_type}:${log.entity_id.slice(0, 8)}`}
                  </td>
                  <td className="change-cell">
                    {log.original_value || log.new_value ? (
                      <>
                        <small>
                          {log.original_value
                            ? "Previous value saved"
                            : "New record"}
                        </small>
                        <strong>→</strong>
                        <small>
                          {log.new_value ? "New value saved" : "State changed"}
                        </small>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{log.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
