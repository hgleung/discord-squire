import { useCallback, useEffect, useState } from 'react';
import type { DayLog, PlanData } from '../../../lib/types';
import {
  DEFAULT_HOST,
  SUGGESTED_MODELS,
  buildWeekInput,
  generateWeekSummary,
  getHost,
  getModel,
  listModels,
  setHost,
  setModel,
} from '../../../lib/weekSummary';
import type { WeekSummary } from '../../../lib/weekSummary';

interface WeekSummaryPanelProps {
  plan: PlanData;
  weekDays: DayLog[];
  selectedDate: string;
}

type Connection =
  | { state: 'unknown' }
  | { state: 'checking' }
  | { state: 'ok'; models: string[] }
  | { state: 'failed'; message: string };

export function WeekSummaryPanel({ plan, weekDays, selectedDate }: WeekSummaryPanelProps) {
  const [summary, setSummary] = useState<WeekSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hostDraft, setHostDraft] = useState(getHost());
  const [model, setModelState] = useState<string | null>(getModel());
  const [connection, setConnection] = useState<Connection>({ state: 'unknown' });

  const hasData = weekDays.some((d) => d.exercises.length > 0);

  const checkConnection = useCallback(async (host: string) => {
    setConnection({ state: 'checking' });
    try {
      const models = await listModels(host);
      setConnection({ state: 'ok', models });
      return models;
    } catch (err) {
      setConnection({ state: 'failed', message: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }, []);

  // Probe once when the settings panel is first opened, not on every render.
  useEffect(() => {
    if (settingsOpen && connection.state === 'unknown') void checkConnection(getHost());
  }, [settingsOpen, connection.state, checkConnection]);

  const run = async () => {
    if (!model) {
      setSettingsOpen(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const input = buildWeekInput(plan, weekDays, selectedDate);
      setSummary(await generateWeekSummary(input, getHost(), model));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-xl border border-neutral-100 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold tracking-wide text-neutral-400">WEEK IN REVIEW</span>
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          className="text-[11px] font-medium text-neutral-400 hover:text-neutral-700"
        >
          {model ? model : 'Set up'}
        </button>
      </div>

      {settingsOpen && (
        <div className="mt-2 rounded-lg bg-neutral-50 p-2.5">
          <p className="mb-2 text-[10.5px] leading-relaxed text-neutral-500">
            Runs a local model through{' '}
            <a
              href="https://ollama.com"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-neutral-700"
            >
              Ollama
            </a>
            . No account, no API key — nothing leaves your machine.
          </p>

          <label className="block text-[11px] text-neutral-500">
            Ollama address
            <div className="mt-1 flex gap-1.5">
              <input
                value={hostDraft}
                onChange={(e) => setHostDraft(e.target.value)}
                placeholder={DEFAULT_HOST}
                className="min-w-0 flex-1 rounded-md border border-neutral-200 px-2 py-1 text-[12px]"
              />
              <button
                onClick={() => {
                  setHost(hostDraft);
                  void checkConnection(hostDraft);
                }}
                className="shrink-0 rounded-md border border-neutral-200 bg-white px-2 py-1 text-[11.5px] font-medium text-neutral-600 hover:bg-neutral-50"
              >
                Check
              </button>
            </div>
          </label>

          {connection.state === 'checking' && (
            <p className="mt-2 text-[11px] text-neutral-400">Looking for Ollama…</p>
          )}

          {connection.state === 'failed' && (
            <div className="mt-2 rounded-md bg-red-50 px-2 py-1.5">
              <p className="text-[11px] leading-relaxed text-red-700">{connection.message}</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-red-600/80">
                Install from ollama.com, then pull a small model:
                <code className="ml-1 rounded bg-red-100 px-1">ollama pull llama3.2</code>
              </p>
            </div>
          )}

          {connection.state === 'ok' && connection.models.length === 0 && (
            <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
              Ollama is running but has no models. Pull one:
              <code className="ml-1 rounded bg-amber-100 px-1">ollama pull llama3.2</code>
            </div>
          )}

          {connection.state === 'ok' && connection.models.length > 0 && (
            <label className="mt-2 block text-[11px] text-neutral-500">
              Model
              <select
                value={model ?? ''}
                onChange={(e) => {
                  setModelState(e.target.value);
                  setModel(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-neutral-200 px-2 py-1 text-[12px]"
              >
                <option value="" disabled>
                  Choose a model…
                </option>
                {connection.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[10.5px] text-neutral-400">
                A small model is plenty — the figures are already computed. Good picks:{' '}
                {SUGGESTED_MODELS.join(', ')}.
              </span>
            </label>
          )}

          <div className="mt-2 flex justify-end">
            <button
              onClick={() => setSettingsOpen(false)}
              className="rounded-md bg-neutral-900 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-neutral-700"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {summary && !loading && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[13px] font-semibold leading-snug text-neutral-800">{summary.headline}</p>
          <SummaryBlock label="Effort" text={summary.effort} />
          <SummaryBlock label="Improvement" text={summary.improvement} />
          <SummaryBlock label="Next week" text={summary.focus} />
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11.5px] leading-relaxed text-red-700">
          {error}
        </p>
      )}

      <button
        onClick={run}
        disabled={loading || !hasData}
        className="mt-2.5 w-full rounded-lg border border-neutral-200 py-1.5 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {loading
          ? 'Reading your week…'
          : !hasData
            ? 'Nothing logged this week'
            : summary
              ? 'Regenerate'
              : '✨ Summarize this week'}
      </button>
    </section>
  );
}

function SummaryBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold tracking-wide text-neutral-300">{label.toUpperCase()}</div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-neutral-600">{text}</p>
    </div>
  );
}
