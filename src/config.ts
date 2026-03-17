const DEFAULT_MAX_BINDING_ATTEMPTS = 3;

let runtimeConfig = {
  maxBindingAttempts: DEFAULT_MAX_BINDING_ATTEMPTS,
};

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

export function configureTaskDagRuntime(config?: Record<string, unknown>): void {
  runtimeConfig.maxBindingAttempts = normalizePositiveInt(
    config?.maxBindingAttempts ?? config?.max_binding_attempts ?? process.env.TASK_DAG_MAX_BINDING_ATTEMPTS,
    DEFAULT_MAX_BINDING_ATTEMPTS,
  );
}

export function getTaskDagMaxBindingAttempts(): number {
  return runtimeConfig.maxBindingAttempts;
}
