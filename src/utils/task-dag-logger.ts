type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

const TASK_DAG_LOG_PREFIX = '[task-dag]';

function withTaskDagPrefix(message: string): string {
  return message.startsWith(TASK_DAG_LOG_PREFIX) ? message : `${TASK_DAG_LOG_PREFIX} ${message}`;
}

export function taskDagInfo(logger: LoggerLike | undefined, message: string): void {
  logger?.info?.(withTaskDagPrefix(message));
}

export function taskDagWarn(logger: LoggerLike | undefined, message: string): void {
  logger?.warn?.(withTaskDagPrefix(message));
}

export function taskDagError(logger: LoggerLike | undefined, message: string): void {
  logger?.error?.(withTaskDagPrefix(message));
}
