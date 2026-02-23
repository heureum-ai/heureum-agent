# Copyright (c) 2026 Heureum AI. All rights reserved.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat_messages", "0008_suggestedquestion"),
    ]

    operations = [
        migrations.AddField(
            model_name="message",
            name="seq",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddConstraint(
            model_name="message",
            constraint=models.UniqueConstraint(
                condition=models.Q(("seq__isnull", False)),
                fields=("response", "seq"),
                name="unique_response_seq",
            ),
        ),
    ]
