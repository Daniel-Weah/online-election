const express = require('express');
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./election.db");


db.serialize(() => {
    db.run(
      "CREATE TABLE IF NOT EXISTS auth(id INTEGER PRIMARY KEY AUTOINCREMENT, username VARCHAR(50) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, user_id INTEGER)"
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS roles(id INTEGER PRIMARY KEY AUTOINCREMENT, role VARCHAR(50) NOT NULL)"
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, first_name VARCHAR(50) NOT NULL, middle_name VARCHAR(50) NULL, last_name VARCHAR(50) NOT NULL, DOB DATE NOT NULL, profile_picture BLOB NOT NULL, role_id INTEGER,election_id, has_voted INTEGER)"
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS parties(id INTEGER PRIMARY KEY AUTOINCREMENT, party VARCHAR(50) NOT NULL, logo BLOB)"
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS positions(id INTEGER PRIMARY KEY AUTOINCREMENT, position VARCHAR(50) NOT NULL)"
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS candidates(id INTEGER PRIMARY KEY AUTOINCREMENT, first_name VARCHAR(50) NOT NULL, middle_name VARCHAR(50) NULL, last_name VARCHAR(50) NOT NULL, party_id INTEGER NOT NULL, position_id INTEGER NOT NULL, photo BLOB)"
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS votes(id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL, vote INTEGER NOT NULL DEFAULT 0, UNIQUE(candidate_id))"
    );
  
    db.run(
      `
      CREATE TABLE IF NOT EXISTS user_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL
      )
    `
    );
  
    db.run(
      "CREATE TABLE IF NOT EXISTS elections (id INTEGER PRIMARY KEY AUTOINCREMENT, election VARCHAR(50) NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
    );
  
    db.run(
      "CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, username VARCHAR(50) NOT NULL, message VARCHAR(2000) NOT NULL, title VARCHAR(50) NOT NULL, is_read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(username) REFERENCES auth (username))"
    );

  
    // db.run(
    //   "DROP TABLE auth"
    // );
    // db.run(
    //   "DROP TABLE users"
    // );
    // db.run(
    //   "DROP TABLE parties"
    // );
    // db.run(
    //   "DROP TABLE positions"
    // );
    // db.run(
    //   "DROP TABLE candidates"
    // );
    // db.run(
    //   "DROP TABLE user_votes"
    // );
    // db.run(
    //   "DROP TABLE votes"
    // );
    // db.run(
    //   "DROP TABLE elections"
    // );
    // db.run(
    //   "DROP TABLE notifications"
    // );
  });

  module.exports = db;