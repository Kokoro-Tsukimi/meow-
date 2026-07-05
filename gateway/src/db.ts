import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT) || 3306,
  database: process.env.MYSQL_DATABASE || 'meow_gateway',
  user: process.env.MYSQL_USER || 'meow_user',
  password: process.env.MYSQL_PASSWORD || '666',
  waitForConnections: true,
  connectionLimit: 10,
});

console.info('[DB][连接] MySQL连接池已初始化');