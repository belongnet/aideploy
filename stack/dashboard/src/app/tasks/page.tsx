"use client";

import { useEffect, useState, useCallback } from "react";
import {
  fetchTasks,
  toggleTask,
  generateTask,
  createTask,
  testTask,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Task {
  id: string;
  name: string;
  description: string;
  trigger: string;
  action: string;
  enabled: boolean;
  lastRun: string | null;
  runCount: number;
}

/* Trigger and action options for the visual builder */
const TRIGGER_OPTIONS = [
  { value: "message_contains", label: "When a message contains..." },
  { value: "message_received", label: "When any message is received" },
  { value: "scheduled", label: "On a schedule" },
  { value: "keyword", label: "When a keyword is mentioned" },
  { value: "channel_event", label: "When someone joins a channel" },
  { value: "agent_message", label: "When another agent sends a message" },
];

const ACTION_OPTIONS = [
  { value: "reply", label: "Send a reply" },
  { value: "forward", label: "Forward to another app" },
  { value: "agent_forward", label: "Send to another agent" },
  { value: "webhook", label: "Call an external service" },
  { value: "summary", label: "Generate a summary" },
];

/* ------------------------------------------------------------------ */
/*  Tasks Page                                                         */
/* ------------------------------------------------------------------ */

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<"ai" | "builder">("ai");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testOutput, setTestOutput] = useState<string | null>(null);

  /* AI generation state */
  const [aiPrompt, setAiPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{
    name: string;
    trigger: string;
    action: string;
    description: string;
  } | null>(null);

  /* Visual builder state */
  const [builderName, setBuilderName] = useState("");
  const [builderDesc, setBuilderDesc] = useState("");
  const [builderTrigger, setBuilderTrigger] = useState(
    TRIGGER_OPTIONS[0].value
  );
  const [builderAction, setBuilderAction] = useState(ACTION_OPTIONS[0].value);

  /* Saving state */
  const [saving, setSaving] = useState(false);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchTasks();
      setTasks(data as Task[]);
    } catch {
      /* Silent fail */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  const handleToggle = async (task: Task) => {
    const newEnabled = !task.enabled;
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id ? { ...t, enabled: newEnabled } : t
      )
    );
    try {
      await toggleTask(task.id, newEnabled);
    } catch {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id ? { ...t, enabled: !newEnabled } : t
        )
      );
    }
  };

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    setGenerated(null);
    try {
      const result = await generateTask(aiPrompt.trim());
      setGenerated(result);
    } catch {
      /* Show error inline */
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveAiTask = async () => {
    if (!generated) return;
    setSaving(true);
    try {
      await createTask(generated);
      setShowCreate(false);
      setAiPrompt("");
      setGenerated(null);
      load();
    } catch {
      /* Silent fail */
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBuilderTask = async () => {
    if (!builderName.trim()) return;
    setSaving(true);
    try {
      await createTask({
        name: builderName.trim(),
        description: builderDesc.trim(),
        trigger: builderTrigger,
        action: builderAction,
      });
      setShowCreate(false);
      resetBuilder();
      load();
    } catch {
      /* Silent fail */
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (task: Task) => {
    setTestingId(task.id);
    setTestOutput(null);
    try {
      const result = await testTask(task.id);
      setTestOutput(result.output);
    } catch (err: any) {
      setTestOutput(`Error: ${err?.message ?? "Test failed"}`);
    } finally {
      setTestingId(null);
    }
  };

  const resetBuilder = () => {
    setBuilderName("");
    setBuilderDesc("");
    setBuilderTrigger(TRIGGER_OPTIONS[0].value);
    setBuilderAction(ACTION_OPTIONS[0].value);
  };

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const triggerLabel = (value: string) =>
    TRIGGER_OPTIONS.find((t) => t.value === value)?.label ?? value;

  const actionLabel = (value: string) =>
    ACTION_OPTIONS.find((a) => a.value === value)?.label ?? value;

  const formatDate = (iso: string | null) => {
    if (!iso) return "Never";
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="mt-1 text-sm text-gray-500">
            Automate actions your agent takes when something happens.
          </p>
        </div>
        <button
          onClick={() => {
            setShowCreate(true);
            setGenerated(null);
            setAiPrompt("");
            resetBuilder();
          }}
          className="btn-primary"
        >
          <svg className="mr-1.5 h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Create Task
        </button>
      </div>

      {/* -------------------------------------------------------------- */}
      {/*  Create task panel (slide-in)                                   */}
      {/* -------------------------------------------------------------- */}
      {showCreate && (
        <div className="card space-y-5 border-2 border-brand-200">
          <div className="flex items-center justify-between">
            <h2 className="section-title">New Task</h2>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 min-h-touch min-w-touch"
              aria-label="Close"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Mode toggle */}
          <div className="flex rounded-lg bg-gray-100 p-1">
            <button
              onClick={() => setCreateMode("ai")}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition min-h-touch ${
                createMode === "ai"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              Describe what you want
            </button>
            <button
              onClick={() => setCreateMode("builder")}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition min-h-touch ${
                createMode === "builder"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              Build step by step
            </button>
          </div>

          {/* AI generation mode */}
          {createMode === "ai" && (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="ai-prompt"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Describe what you want this task to do
                </label>
                <textarea
                  id="ai-prompt"
                  rows={3}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder='For example: "When someone asks about pricing, reply with our current rates" or "Every morning, send a summary of yesterday\'s conversations to Slack"'
                  className="input-field resize-none"
                />
              </div>
              <button
                onClick={handleGenerate}
                disabled={generating || !aiPrompt.trim()}
                className="btn-primary"
              >
                {generating ? (
                  <>
                    <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Creating your task...
                  </>
                ) : (
                  "Create with AI"
                )}
              </button>

              {/* Generated preview */}
              {generated && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-sm font-semibold text-green-800">
                      Here is what I came up with
                    </span>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="font-medium text-gray-700">Name: </span>
                      <span className="text-gray-900">{generated.name}</span>
                    </div>
                    <div>
                      <span className="font-medium text-gray-700">
                        When:{" "}
                      </span>
                      <span className="text-gray-900">
                        {triggerLabel(generated.trigger)}
                      </span>
                    </div>
                    <div>
                      <span className="font-medium text-gray-700">
                        Then:{" "}
                      </span>
                      <span className="text-gray-900">
                        {actionLabel(generated.action)}
                      </span>
                    </div>
                    <div>
                      <span className="font-medium text-gray-700">
                        Details:{" "}
                      </span>
                      <span className="text-gray-900">
                        {generated.description}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleSaveAiTask}
                      disabled={saving}
                      className="btn-primary text-sm"
                    >
                      {saving ? "Saving..." : "Save Task"}
                    </button>
                    <button
                      onClick={() => setGenerated(null)}
                      className="btn-secondary text-sm"
                    >
                      Try Again
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Visual builder mode */}
          {createMode === "builder" && (
            <div className="space-y-4">
              {/* Task name */}
              <div>
                <label
                  htmlFor="task-name"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Task name
                </label>
                <input
                  id="task-name"
                  type="text"
                  value={builderName}
                  onChange={(e) => setBuilderName(e.target.value)}
                  placeholder="Give your task a short name"
                  className="input-field"
                />
              </div>

              {/* Description */}
              <div>
                <label
                  htmlFor="task-desc"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Description (optional)
                </label>
                <textarea
                  id="task-desc"
                  rows={2}
                  value={builderDesc}
                  onChange={(e) => setBuilderDesc(e.target.value)}
                  placeholder="What does this task do?"
                  className="input-field resize-none"
                />
              </div>

              {/* Trigger selector */}
              <div>
                <label
                  htmlFor="task-trigger"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  When this happens...
                </label>
                <select
                  id="task-trigger"
                  value={builderTrigger}
                  onChange={(e) => setBuilderTrigger(e.target.value)}
                  className="input-field"
                >
                  {TRIGGER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Action selector */}
              <div>
                <label
                  htmlFor="task-action"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  ...do this
                </label>
                <select
                  id="task-action"
                  value={builderAction}
                  onChange={(e) => setBuilderAction(e.target.value)}
                  className="input-field"
                >
                  {ACTION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Visual summary */}
              <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-4 py-3 text-sm">
                <span className="rounded-md bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700">
                  When
                </span>
                <span className="text-gray-700">
                  {
                    TRIGGER_OPTIONS.find((t) => t.value === builderTrigger)
                      ?.label
                  }
                </span>
                <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
                <span className="rounded-md bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
                  Then
                </span>
                <span className="text-gray-700">
                  {
                    ACTION_OPTIONS.find((a) => a.value === builderAction)
                      ?.label
                  }
                </span>
              </div>

              <button
                onClick={handleSaveBuilderTask}
                disabled={saving || !builderName.trim()}
                className="btn-primary"
              >
                {saving ? "Saving..." : "Save Task"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* -------------------------------------------------------------- */}
      {/*  Task list                                                      */}
      {/* -------------------------------------------------------------- */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse h-20 rounded-xl bg-gray-200"
            />
          ))}
        </div>
      ) : tasks.length > 0 ? (
        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`card transition ${
                !task.enabled ? "opacity-60" : ""
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                {/* Task info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-900">
                      {task.name}
                    </h3>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        task.enabled
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {task.enabled ? "Active" : "Off"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {task.description}
                  </p>

                  {/* Trigger/action badges */}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-blue-700">
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                      </svg>
                      {triggerLabel(task.trigger)}
                    </span>
                    <svg className="h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                    </svg>
                    <span className="inline-flex items-center gap-1 rounded-md bg-green-50 px-2 py-1 text-green-700">
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
                      </svg>
                      {actionLabel(task.action)}
                    </span>
                  </div>

                  {/* Run stats */}
                  <p className="mt-2 text-[11px] text-gray-400">
                    Last run: {formatDate(task.lastRun)} &middot;{" "}
                    {task.runCount} total runs
                  </p>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-2 shrink-0">
                  {/* Test button */}
                  <button
                    onClick={() => handleTest(task)}
                    disabled={testingId === task.id}
                    className="btn-secondary text-xs px-3"
                  >
                    {testingId === task.id ? (
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                    ) : (
                      "Test"
                    )}
                  </button>

                  {/* Enable/disable toggle */}
                  <button
                    onClick={() => handleToggle(task)}
                    className={`toggle-track ${
                      task.enabled ? "bg-brand-600" : "bg-gray-200"
                    }`}
                    role="switch"
                    aria-checked={task.enabled}
                    aria-label={`${task.enabled ? "Disable" : "Enable"} ${task.name}`}
                  >
                    <span
                      className={`toggle-knob ${
                        task.enabled ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Test output panel */}
              {testOutput && testingId === null && task.id === tasks.find((t) => t.id === task.id)?.id && (
                <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-gray-600">
                      Test Result
                    </span>
                    <button
                      onClick={() => setTestOutput(null)}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Close
                    </button>
                  </div>
                  <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono">
                    {testOutput}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        /* Empty state */
        <div className="card flex flex-col items-center justify-center py-12 text-center">
          <svg
            className="h-12 w-12 text-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h3 className="mt-3 text-sm font-medium text-gray-600">
            No tasks yet
          </h3>
          <p className="mt-1 text-xs text-gray-400 max-w-sm">
            Tasks automate what your agent does. Create one to get started --
            describe what you want in plain language and your agent will figure
            out the rest.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="btn-primary mt-4 text-sm"
          >
            Create Your First Task
          </button>
        </div>
      )}
    </div>
  );
}
