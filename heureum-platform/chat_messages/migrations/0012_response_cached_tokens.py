# Generated migration for cached_tokens field

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat_messages", "0011_skillschema_toolschema"),
    ]

    operations = [
        migrations.AddField(
            model_name="response",
            name="cached_tokens",
            field=models.IntegerField(default=0),
        ),
    ]
