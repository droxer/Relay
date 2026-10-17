from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from relay.core.environment import load_backend_env
from relay.core.storage_config import normalize_database_url
from relay.persistence.schema import include_alembic_object, metadata as relay_metadata

load_backend_env()

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = relay_metadata


def database_url() -> str:
    url = os.environ.get("RELAY_DATABASE_URL") or os.environ.get("DATABASE_URL") or config.get_main_option("sqlalchemy.url")
    return normalize_database_url(url) if url else url


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_alembic_object,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = database_url()
    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata,
            include_object=include_alembic_object,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
