// @ts-nocheck
/**
 * Prisma's own type conversion for Prisma Postgres, copied UNCHANGED from
 * `@prisma/adapter-ppg` 7.10.1 (Apache-2.0), which does not export it. It turns
 * Prisma's arguments into query parameters, column types into Prisma's types, and
 * driver errors into Prisma's error kinds, so `db-socket.ts` answers exactly as
 * the stock adapter does. Never edit it by hand: when `@prisma/adapter-ppg`
 * changes version, copy it again (`tests/db-socket.test.ts` fails until you do).
 */
export const CONVERSION_FROM_ADAPTER_VERSION = '7.10.1';

import { ColumnTypeEnum } from "@prisma/driver-adapter-utils";
import { getTypeParser } from "pg-types";
import { parse as parseArray } from "postgres-array";
function isolationLevelToSql(level) {
  switch (level) {
    case "READ UNCOMMITTED":
      return "READ UNCOMMITTED";
    case "READ COMMITTED":
      return "READ COMMITTED";
    case "REPEATABLE READ":
      return "REPEATABLE READ";
    case "SERIALIZABLE":
      return "SERIALIZABLE";
    case "SNAPSHOT":
      return "REPEATABLE READ";
    default:
      throw new Error(`Unknown isolation level: ${level}`);
  }
}
function convertArgs(args, argTypes) {
  return args.map((arg, index) => {
    const argType = argTypes[index];
    if (arg === null || arg === void 0) {
      return null;
    }
    const scalarType = argType.scalarType;
    switch (scalarType) {
      case "int":
      case "bigint":
      case "float":
      case "decimal":
      case "string":
      case "enum":
      case "boolean":
        return String(arg);
      case "datetime":
        if (arg instanceof Date) {
          return arg.toISOString();
        }
        return arg;
      case "json":
        return typeof arg === "string" ? arg : JSON.stringify(arg);
      case "bytes":
        if (arg instanceof Uint8Array) {
          return `\\x${Array.from(arg).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
        }
        return arg;
      case "uuid":
        return String(arg);
      case "unknown":
      default:
        return arg;
    }
  });
}
var ScalarColumnType = {
  BOOL: 16,
  BYTEA: 17,
  CHAR: 18,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  REGPROC: 24,
  TEXT: 25,
  OID: 26,
  TID: 27,
  XID: 28,
  CID: 29,
  JSON: 114,
  XML: 142,
  PG_NODE_TREE: 194,
  SMGR: 210,
  PATH: 602,
  POLYGON: 604,
  CIDR: 650,
  FLOAT4: 700,
  FLOAT8: 701,
  ABSTIME: 702,
  RELTIME: 703,
  TINTERVAL: 704,
  CIRCLE: 718,
  MACADDR8: 774,
  MONEY: 790,
  MACADDR: 829,
  INET: 869,
  ACLITEM: 1033,
  BPCHAR: 1042,
  VARCHAR: 1043,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  INTERVAL: 1186,
  TIMETZ: 1266,
  BIT: 1560,
  VARBIT: 1562,
  NUMERIC: 1700,
  REFCURSOR: 1790,
  REGPROCEDURE: 2202,
  REGOPER: 2203,
  REGOPERATOR: 2204,
  REGCLASS: 2205,
  REGTYPE: 2206,
  UUID: 2950,
  TXID_SNAPSHOT: 2970,
  PG_LSN: 3220,
  PG_NDISTINCT: 3361,
  PG_DEPENDENCIES: 3402,
  TSVECTOR: 3614,
  TSQUERY: 3615,
  GTSVECTOR: 3642,
  REGCONFIG: 3734,
  REGDICTIONARY: 3769,
  JSONB: 3802,
  REGNAMESPACE: 4089,
  REGROLE: 4096
};
var ArrayColumnType = {
  BIT_ARRAY: 1561,
  BOOL_ARRAY: 1e3,
  BYTEA_ARRAY: 1001,
  BPCHAR_ARRAY: 1014,
  CHAR_ARRAY: 1002,
  CIDR_ARRAY: 651,
  DATE_ARRAY: 1182,
  FLOAT4_ARRAY: 1021,
  FLOAT8_ARRAY: 1022,
  INET_ARRAY: 1041,
  INT2_ARRAY: 1005,
  INT4_ARRAY: 1007,
  INT8_ARRAY: 1016,
  JSONB_ARRAY: 3807,
  JSON_ARRAY: 199,
  MONEY_ARRAY: 791,
  NUMERIC_ARRAY: 1231,
  OID_ARRAY: 1028,
  TEXT_ARRAY: 1009,
  TIMESTAMP_ARRAY: 1115,
  TIMESTAMPTZ_ARRAY: 1185,
  TIME_ARRAY: 1183,
  UUID_ARRAY: 2951,
  VARBIT_ARRAY: 1563,
  VARCHAR_ARRAY: 1015,
  XML_ARRAY: 143
};
function fieldToColumnType(fieldTypeId) {
  switch (fieldTypeId) {
    case ScalarColumnType.INT2:
    case ScalarColumnType.INT4:
      return ColumnTypeEnum.Int32;
    case ScalarColumnType.INT8:
      return ColumnTypeEnum.Int64;
    case ScalarColumnType.FLOAT4:
      return ColumnTypeEnum.Float;
    case ScalarColumnType.FLOAT8:
      return ColumnTypeEnum.Double;
    case ScalarColumnType.BOOL:
      return ColumnTypeEnum.Boolean;
    case ScalarColumnType.DATE:
      return ColumnTypeEnum.Date;
    case ScalarColumnType.TIME:
    case ScalarColumnType.TIMETZ:
      return ColumnTypeEnum.Time;
    case ScalarColumnType.TIMESTAMP:
    case ScalarColumnType.TIMESTAMPTZ:
      return ColumnTypeEnum.DateTime;
    case ScalarColumnType.NUMERIC:
    case ScalarColumnType.MONEY:
      return ColumnTypeEnum.Numeric;
    case ScalarColumnType.JSON:
    case ScalarColumnType.JSONB:
      return ColumnTypeEnum.Json;
    case ScalarColumnType.UUID:
      return ColumnTypeEnum.Uuid;
    case ScalarColumnType.OID:
      return ColumnTypeEnum.Int64;
    case ScalarColumnType.BPCHAR:
    case ScalarColumnType.TEXT:
    case ScalarColumnType.VARCHAR:
    case ScalarColumnType.BIT:
    case ScalarColumnType.VARBIT:
    case ScalarColumnType.INET:
    case ScalarColumnType.CIDR:
    case ScalarColumnType.XML:
      return ColumnTypeEnum.Text;
    case ScalarColumnType.BYTEA:
      return ColumnTypeEnum.Bytes;
    case ArrayColumnType.INT2_ARRAY:
    case ArrayColumnType.INT4_ARRAY:
      return ColumnTypeEnum.Int32Array;
    case ArrayColumnType.FLOAT4_ARRAY:
      return ColumnTypeEnum.FloatArray;
    case ArrayColumnType.FLOAT8_ARRAY:
      return ColumnTypeEnum.DoubleArray;
    case ArrayColumnType.NUMERIC_ARRAY:
    case ArrayColumnType.MONEY_ARRAY:
      return ColumnTypeEnum.NumericArray;
    case ArrayColumnType.BOOL_ARRAY:
      return ColumnTypeEnum.BooleanArray;
    case ArrayColumnType.CHAR_ARRAY:
      return ColumnTypeEnum.CharacterArray;
    case ArrayColumnType.BPCHAR_ARRAY:
    case ArrayColumnType.TEXT_ARRAY:
    case ArrayColumnType.VARCHAR_ARRAY:
    case ArrayColumnType.VARBIT_ARRAY:
    case ArrayColumnType.BIT_ARRAY:
    case ArrayColumnType.INET_ARRAY:
    case ArrayColumnType.CIDR_ARRAY:
    case ArrayColumnType.XML_ARRAY:
      return ColumnTypeEnum.TextArray;
    case ArrayColumnType.DATE_ARRAY:
      return ColumnTypeEnum.DateArray;
    case ArrayColumnType.TIME_ARRAY:
      return ColumnTypeEnum.TimeArray;
    case ArrayColumnType.TIMESTAMP_ARRAY:
      return ColumnTypeEnum.DateTimeArray;
    case ArrayColumnType.JSON_ARRAY:
    case ArrayColumnType.JSONB_ARRAY:
      return ColumnTypeEnum.JsonArray;
    case ArrayColumnType.BYTEA_ARRAY:
      return ColumnTypeEnum.BytesArray;
    case ArrayColumnType.UUID_ARRAY:
      return ColumnTypeEnum.UuidArray;
    case ArrayColumnType.INT8_ARRAY:
    case ArrayColumnType.OID_ARRAY:
      return ColumnTypeEnum.Int64Array;
    default:
      if (fieldTypeId >= 1e4) {
        return ColumnTypeEnum.Text;
      }
      throw new UnsupportedNativeDataType(fieldTypeId);
  }
}
var UnsupportedNativeDataType = class extends Error {
  constructor(code) {
    super(`Unsupported column type id ${code}`);
  }
};
var builtinParsers = Object.entries({
  [ScalarColumnType.BOOL]: normalize_bool,
  [ScalarColumnType.NUMERIC]: normalize_numeric,
  [ArrayColumnType.NUMERIC_ARRAY]: normalize_array(normalize_numeric),
  [ScalarColumnType.TIME]: normalize_time,
  [ArrayColumnType.TIME_ARRAY]: normalize_array(normalize_time),
  [ScalarColumnType.TIMETZ]: normalize_timez,
  [ScalarColumnType.DATE]: normalize_date,
  [ArrayColumnType.DATE_ARRAY]: normalize_array(normalize_date),
  [ScalarColumnType.TIMESTAMP]: normalize_timestamp,
  [ArrayColumnType.TIMESTAMP_ARRAY]: normalize_array(normalize_timestamp),
  [ScalarColumnType.TIMESTAMPTZ]: normalize_timestamptz,
  [ArrayColumnType.TIMESTAMPTZ_ARRAY]: normalize_array(normalize_timestamptz),
  [ScalarColumnType.MONEY]: normalize_money,
  [ArrayColumnType.MONEY_ARRAY]: normalize_array(normalize_money),
  [ScalarColumnType.JSON]: toJson,
  [ArrayColumnType.JSON_ARRAY]: normalize_array(toJson),
  [ScalarColumnType.JSONB]: toJson,
  [ArrayColumnType.JSONB_ARRAY]: normalize_array(toJson),
  [ScalarColumnType.BYTEA]: convertBytes,
  [ArrayColumnType.BYTEA_ARRAY]: normalizeByteaArray,
  [ArrayColumnType.BIT_ARRAY]: normalize_array(normalizeBit),
  [ArrayColumnType.VARBIT_ARRAY]: normalize_array(normalizeBit),
  [ArrayColumnType.XML_ARRAY]: normalize_array(normalize_xml)
}).map(([k, v]) => ({
  oid: Number(k),
  parse: v
}));
function normalize_bool(x) {
  return x === null ? null : x === "f" ? "false" : "true";
}
function normalize_array(element_normalizer) {
  return (str) => {
    if (str === null) return null;
    return parseArray(str, element_normalizer);
  };
}
function normalize_numeric(numeric) {
  return numeric;
}
function normalize_date(date) {
  return date;
}
function normalize_timestamp(time) {
  if (time === null) return null;
  return `${time.replace(" ", "T")}+00:00`;
}
function normalize_timestamptz(time) {
  if (time === null) return null;
  return time.replace(" ", "T").replace(/[+-]\d{2}(:\d{2})?$/, "+00:00");
}
function normalize_time(time) {
  return time;
}
function normalize_timez(time) {
  if (time === null) return null;
  return time.replace(/[+-]\d{2}(:\d{2})?$/, "");
}
function normalize_money(money) {
  if (money === null) return null;
  return money.slice(1);
}
function normalize_xml(xml) {
  return xml;
}
function toJson(json) {
  return json;
}
function parsePgBytes(x) {
  return Buffer.from(x, "base64");
}
var builtInByteParser = getTypeParser(ScalarColumnType.BYTEA);
function normalizeByteaArray(x) {
  if (x === null) return null;
  return parseArray(x).map((elem) => elem === null ? null : builtInByteParser(elem));
}
function convertBytes(serializedBytes) {
  if (serializedBytes === null) return null;
  return parsePgBytes(serializedBytes);
}
function normalizeBit(bit) {
  return bit;
}

function convertDriverError(error) {
  if (isDriverError(error)) {
    return {
      originalCode: error.code,
      originalMessage: error.message,
      ...mapDriverError(error)
    };
  }
  throw error;
}
function mapDriverError(error) {
  switch (error.code) {
    case "22001":
      return {
        kind: "LengthMismatch",
        column: error.details.column
      };
    case "22003":
      return {
        kind: "ValueOutOfRange",
        cause: error.message
      };
    case "22P02":
      return {
        kind: "InvalidInputValue",
        message: error.message
      };
    case "23505": {
      let constraint;
      if (error.details.constraint) {
        constraint = { index: error.details.constraint };
      } else {
        const fields = error.details.detail?.match(/Key \(([^)]+)\)/)?.at(1)?.split(", ");
        if (fields !== void 0) {
          constraint = { fields };
        }
      }
      return {
        kind: "UniqueConstraintViolation",
        constraint
      };
    }
    case "23502": {
      const fields = error.details.detail?.match(/Key \(([^)]+)\)/)?.at(1)?.split(", ");
      return {
        kind: "NullConstraintViolation",
        constraint: fields !== void 0 ? { fields } : void 0
      };
    }
    case "23503": {
      let constraint;
      if (error.details.column) {
        constraint = { fields: [error.details.column] };
      } else if (error.details.constraint) {
        constraint = { index: error.details.constraint };
      }
      return {
        kind: "ForeignKeyConstraintViolation",
        constraint
      };
    }
    case "23001": {
      let constraint;
      if (error.details.column) {
        constraint = { fields: [error.details.column] };
      } else if (error.details.constraint) {
        constraint = { index: error.details.constraint };
      }
      return {
        kind: "RestrictViolation",
        constraint
      };
    }
    case "3D000":
      return {
        kind: "DatabaseDoesNotExist",
        db: error.message.split(" ").at(1)?.split('"').at(1)
      };
    case "28000":
      return {
        kind: "DatabaseAccessDenied",
        db: error.message.split(",").find((s) => s.startsWith(" database"))?.split('"').at(1)
      };
    case "28P01":
      return {
        kind: "AuthenticationFailed",
        user: error.message.split(" ").pop()?.split('"').at(1)
      };
    case "40001":
    case "40P01":
      return {
        kind: "TransactionWriteConflict"
      };
    case "42P01":
      return {
        kind: "TableDoesNotExist",
        table: error.message.split(" ").at(1)?.split('"').at(1)
      };
    case "42703": {
      const rawColumn = error.message.match(/^column (.+) does not exist$/)?.at(1);
      return {
        kind: "ColumnNotFound",
        column: rawColumn?.replace(/"((?:""|[^"])*)"/g, (_, id) => id.replaceAll('""', '"'))
      };
    }
    case "42P04":
      return {
        kind: "DatabaseAlreadyExists",
        db: error.message.split(" ").at(1)?.split('"').at(1)
      };
    case "53300":
      return {
        kind: "TooManyConnections",
        cause: error.message
      };
    default:
      return {
        kind: "postgres",
        code: error.code ?? "N/A",
        severity: error.details.severity ?? "N/A",
        message: error.message,
        detail: error.details.detail,
        column: error.details.column,
        hint: error.details.hint
      };
  }
}
function isDriverError(error) {
  return typeof error.code === "string" && typeof error.message === "string" && typeof error.details === "object" && typeof error.details.severity === "string" && (typeof error.details.detail === "string" || error.details.detail === void 0) && (typeof error.details.column === "string" || error.details.column === void 0) && (typeof error.details.hint === "string" || error.details.hint === void 0);
}


export {isolationLevelToSql, convertArgs, fieldToColumnType, convertDriverError, builtinParsers};
