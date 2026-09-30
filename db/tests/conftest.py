"""Shared fixtures for the Postgres record store tests.

The session creates a throwaway database jnj_test_<uuid> on the local server named by
JNJ_TEST_ADMIN_DSN (default: the unix socket in /tmp, port 5432), migrates it, and drops it
WITH (FORCE) at the end. There is no skip: a missing server is an error.
"""
import uuid

import psycopg
import pytest

from migrate import migrate
from support import ADMIN_DSN


@pytest.fixture(scope="session")
def database():
    name = f"jnj_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(ADMIN_DSN, autocommit=True) as admin:
        admin.execute(f'create database "{name}"')
    dsn = psycopg.conninfo.make_conninfo(ADMIN_DSN, dbname=name)
    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            migrate(conn)
        yield dsn
    finally:
        with psycopg.connect(ADMIN_DSN, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{name}" with (force)')


@pytest.fixture
def conn(database):
    with psycopg.connect(database, autocommit=True) as connection:
        yield connection


@pytest.fixture
def make_workspace(conn):
    """Create a workspace as the admin (only the admin may mark one synthetic)."""
    def make(policy="synthetic"):
        slug = f"ws-{uuid.uuid4().hex[:10]}"
        conn.execute("insert into jnj.workspace (slug, content_policy) values (%s, %s)", (slug, policy))
        return slug
    return make
