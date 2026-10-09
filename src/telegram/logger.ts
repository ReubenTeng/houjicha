export type LogValue = string | number | boolean;

export type LogFields = Record<string, LogValue>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LogWriter {
  info(line: string): void;
  error(line: string): void;
}

export function createLogger(
  writer: LogWriter = {
    info: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
  },
): Logger {
  const write = (
    level: "info" | "error",
    event: string,
    fields?: LogFields,
  ): void => {
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...(fields === undefined ? {} : { fields }),
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      writer.error(line);
      return;
    }
    writer.info(line);
  };

  return {
    info: (event, fields) => {
      write("info", event, fields);
    },
    error: (event, fields) => {
      write("error", event, fields);
    },
  };
}
