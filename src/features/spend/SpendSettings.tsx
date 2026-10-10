import { useState } from "react";
import { Wallet } from "lucide-react";
import { Button, EmptyState, Portrait, SelectField, SkeletonRows, TextField, cx } from "../../design";
import type { Budget, SpendGroup, SpendSummary } from "../../lib/bindings";
import { errorMessage } from "../../lib/errors";
import { formatCost, formatTokens } from "../../lib/format";
import { useConfig } from "../../stores/config";
import { useSpend } from "../../stores/spend";
import { useLimits } from "../../stores/limits";
import LimitsDetail from "../limits/LimitsDetail";
import { barPercent, budgetMeter, folderName, reportedCost, spendDate } from "./spendModel";
import "./spend.css";

function BudgetEditor({ budget }: { budget: Budget }) {
  const [period, setPeriod] = useState(budget.limit_usd > 0 ? budget.period : "off");
  const [amount, setAmount] = useState(budget.limit_usd > 0 ? String(budget.limit_usd) : "");
  const [warning, setWarning] = useState(String(budget.warn_percent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="spend-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
          await useSpend.getState().save({
            period: period === "off" ? budget.period : (period as Budget["period"]),
            limit_usd: period === "off" ? 0 : Number(amount),
            warn_percent: Number(warning),
          });
        } catch (e) {
          setError(errorMessage(e, "The budget couldn't be saved. Try again."));
        } finally {
          setSaving(false);
        }
      }}
    >
      <SelectField
        label="Budget period"
        value={period}
        onChange={setPeriod}
        options={[
          { value: "off", label: "Off" },
          { value: "day", label: "Per day" },
          { value: "week", label: "Per week" },
          { value: "month", label: "Per month" },
        ]}
      />
      <TextField
        label="Amount in dollars"
        type="number"
        min="0.01"
        step="0.01"
        required={period !== "off"}
        disabled={period === "off"}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <TextField label="Warn me at (%)" type="number" min="50" max="95" step="1" required value={warning} onChange={(e) => setWarning(e.target.value)} />
      <Button type="submit" variant="primary" disabled={saving}>
        {saving ? "Saving…" : "Save budget"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function BudgetCard({ summary }: { summary: SpendSummary }) {
  const { budget, budget_spend: spent } = summary;
  const meter = budgetMeter(budget, spent);
  const periodLabel = budget.period === "day" ? "today" : `this ${budget.period}`;
  return (
    <section className="settings-card" aria-label="Spending budget">
      <h2 className="settings-card-title">Budget</h2>
      {meter.enabled ? (
        <>
          <p>
            {formatCost(spent)} of {formatCost(budget.limit_usd)} {periodLabel} · {formatCost(meter.left)} left
          </p>
          <div
            className={cx("spend-meter", `spend-tone-${meter.tone}`)}
            role="meter"
            aria-label="Budget used"
            aria-valuemin={0}
            aria-valuemax={budget.limit_usd}
            aria-valuenow={Math.min(spent, budget.limit_usd)}
            aria-valuetext={`${formatCost(spent)} used of ${formatCost(budget.limit_usd)}`}
          >
            <span className="spend-meter-fill" style={{ width: `${meter.fill}%` }} />
            <span className="spend-warning-line" style={{ left: `${budget.warn_percent}%` }} />
          </div>
          <p className="spend-note">
            Warning at {budget.warn_percent}% ({formatCost(meter.warning)}).
          </p>
        </>
      ) : (
        <p>Budget is off.</p>
      )}
      <p className="spend-note">
        Agents keep working when the budget is used up. Each warning comes once a period, and again if you change the budget. Weeks start on Monday, in your
        Mac's local time.
      </p>
      <BudgetEditor key={`${budget.period}-${budget.limit_usd}-${budget.warn_percent}`} budget={budget} />
    </section>
  );
}

function PlanLimits() {
  const limits = useLimits((s) => s.limits);
  return (
    <section className="settings-card" aria-label="Plan usage limits">
      <h2 className="settings-card-title">Plan limits</h2>
      {limits ? (
        <LimitsDetail limits={limits} onRefresh={() => void useLimits.getState().refresh().catch((e) => console.error("[limits] couldn't read usage limits", e))} />
      ) : (
        <SkeletonRows label="Loading usage limits" />
      )}
      <p className="spend-note">
        Claude's numbers come from Claude Code's own usage check and each turn's report; Codex's come from Codex. Starkline checks every few minutes and after
        each turn, and never reads either sign-in.
      </p>
    </section>
  );
}

function Breakdown({ title, rows, kind }: { title: string; rows: SpendGroup[]; kind: "agent" | "project" | "model" }) {
  const agents = useConfig((s) => s.config?.agents);
  return (
    <section className="settings-card" aria-label={title}>
      <h2 className="settings-card-title">{title}</h2>
      {rows.length === 0 ? (
        <p className="spend-note">No turns recorded this month.</p>
      ) : (
        <table className="spend-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{kind === "agent" ? "Agent" : kind === "project" ? "Project" : "Model"}</th>
              <th scope="col">Cost</th>
              <th scope="col">Turns</th>
              <th scope="col">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, total }) => {
              const agent = kind === "agent" ? agents?.find((a) => a.id === key) : undefined;
              const name = kind === "agent" ? (agent?.name ?? "Former agent") : kind === "project" ? folderName(key) : key || "Provider default";
              return (
                <tr key={key}>
                  <th scope="row">
                    <span className="spend-name" title={kind === "project" ? key : undefined}>
                      {kind === "agent" && <Portrait name={name} figure={agent?.figure} accent={agent?.accent} size={24} />}
                      {name}
                    </span>
                  </th>
                  <td>
                    {reportedCost(total)}
                    {total.unpriced_turns > 0 && (
                      <small>
                        {total.unpriced_turns} {total.unpriced_turns === 1 ? "turn" : "turns"} without a price
                      </small>
                    )}
                  </td>
                  <td>{total.turns}</td>
                  <td title={`${total.input_tokens.toLocaleString()} input, ${total.output_tokens.toLocaleString()} output`}>
                    {formatTokens(total.input_tokens + total.output_tokens)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function SpendSettings() {
  const summary = useSpend((s) => s.summary);
  const error = useSpend((s) => s.error);
  const retry = () =>
    void useSpend
      .getState()
      .refresh()
      .catch(() => {});
  if (!summary) {
    return error ? (
      <EmptyState icon={Wallet} title="Spending couldn't be loaded" body={error} action={<Button onClick={retry}>Try again</Button>} />
    ) : (
      <SkeletonRows label="Loading spending" />
    );
  }
  const maximum = Math.max(...summary.days.map((day) => day.total.cost_usd), 0);
  const today = summary.days[summary.days.length - 1]?.date;
  const totals = [
    { label: "Today", total: summary.today },
    { label: "This week", total: summary.week },
    { label: "This month", total: summary.month },
  ];
  return (
    <div className="settings-section spend-settings">
      <header className="screen-header">
        <h1 className="screen-title">Spend</h1>
        <p className="screen-subtitle">What your agents use, how much of your plans is left, and the budget you set.</p>
      </header>
      {error && (
        <p role="alert">
          {error} <Button onClick={retry}>Try again</Button>
        </p>
      )}
      <PlanLimits />
      <div className="spend-totals">
        {totals.map(({ label, total }) => (
          <section className="settings-card" aria-label={label} key={label}>
            <h2 className="settings-card-title">{label}</h2>
            <strong>{reportedCost(total)}</strong>
          </section>
        ))}
      </div>
      <BudgetCard summary={summary} />
      {!summary.first_date ? (
        <EmptyState
          icon={Wallet}
          title="No spending recorded yet"
          body="Send an agent a message. Finished turns will appear here, including tokens when a provider doesn't report a price."
        />
      ) : (
        <>
          <section className="settings-card" aria-label="Last 30 days">
            <h2 className="settings-card-title">Last 30 days</h2>
            <div className="spend-chart" aria-hidden>
              {summary.days.map((day) => (
                <div key={day.date} className={cx("spend-day", day.date === today && "is-today")} title={`${spendDate(day.date)}: ${reportedCost(day.total)}`}>
                  <span style={{ height: `${barPercent(day.total.cost_usd, maximum)}%` }} />
                </div>
              ))}
            </div>
            <div className="spend-chart-labels">
              <span>{spendDate(summary.days[0].date)}</span>
              <span>Today</span>
            </div>
            <table className="visually-hidden" aria-label="Daily spending">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Turns without a price</th>
                </tr>
              </thead>
              <tbody>
                {summary.days.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">{spendDate(day.date)}</th>
                    <td>{reportedCost(day.total)}</td>
                    <td>{day.total.unpriced_turns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <Breakdown title="This month by agent" rows={summary.agents} kind="agent" />
          <Breakdown title="This month by project" rows={summary.projects} kind="project" />
          <Breakdown title="This month by model" rows={summary.models} kind="model" />
        </>
      )}
      <section className="settings-card" aria-label="About these amounts">
        <h2 className="settings-card-title">About these amounts</h2>
        <ul className="settings-facts">
          <li>Claude Code reports what each turn would cost at API prices. On a Claude subscription, this is an estimate, not a bill.</li>
          <li>Codex reports tokens only. Its work shows tokens and no cost.</li>
          <li>
            Spending is counted{" "}
            {summary.first_date
              ? `since ${spendDate(summary.first_date)}, when Starkline started recording turns`
              : "from the day Starkline starts recording turns"}
            . Earlier work isn't included.
          </li>
          <li>Tokens in the tables are input plus output. Costs include only turns with a reported price.</li>
        </ul>
      </section>
    </div>
  );
}
